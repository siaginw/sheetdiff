import { render } from "@react-email/render";
import { and, desc, eq, ne } from "drizzle-orm";
import nodemailer from "nodemailer";
import { listAccessibleSpreadsheets } from "./access";
import { computeFootage, runChecks } from "./checks";
import { db } from "./db";
import { notes as notesTable, snapshots, tabs, users, type User } from "./db/schema";
import { detectStationColumns } from "./detect";
import type { SnapshotData } from "./diff/engine";
import { DigestEmail, type DigestSheet } from "./emails/digest";
import { relativeTime } from "./format";
import { getPendingChanges } from "./pending";
import { detectPermitTab, isPermitTabTitle, permitFindings } from "./permits";
import {
  aggregateWeekly,
  dedupeTabData,
  detectOverplacement,
  detectStoppageTab,
  isStoppageTabTitle,
  quietStoppageLog,
  stoppageWeeks,
  weeklyProduction,
} from "./production";
import { decodeSnapshot, latestNonImportSnapshots } from "./snapshots";
import { captureIsStale } from "./staleness";

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** Assemble the digest content for one user's sheets. */
export async function buildDigestSheets(userId: string, now = Date.now()): Promise<DigestSheet[]> {
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRows[0]) return [];
  const sheets = await listAccessibleSpreadsheets(userRows[0]);

  const out: DigestSheet[] = [];
  for (const sheet of sheets) {
    const sheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id)).orderBy(tabs.position);
    const tracked = sheetTabs.filter((t) => t.tracked);
    if (tracked.length === 0) continue;

    const digest: DigestSheet = {
      title: sheet.title,
      url: sheet.url,
      id: sheet.id,
      changes: 0,
      detail: { added: 0, removed: 0, changed: 0 },
      unresolved: 0,
      sampleChanges: [],
      checkCount: 0,
      topChecks: [],
      notes: [],
      footageDelta: 0,
      weekFt: null,
      weekDeltaFt: null,
      placedFt: null,
      designedFt: null,
      remainingFt: null,
      permitCounts: null,
      stoppage: null,
      lastSnapshotAgo: null,
      paused: sheet.scheduleKind === "off",
    };
    // staleness signal: after 3x the hourly window / 48h daily / 8d weekly,
    // consecutive captures have been missed — "all up to date" computed from
    // stale data is a lie. Paused sheets are exempt (not capturing by choice).
    if (sheet.lastSnapshotAt && captureIsStale(sheet, now)) {
      digest.lastSnapshotAgo = relativeTime(sheet.lastSnapshotAt);
    }

    // load every tracked tab's latest data FIRST — the cross-tab dedup needs
    // the whole sheet before any per-tab number is computed (position order:
    // first-wins ownership depends on it)
    const latestDataByTab = new Map<string, SnapshotData>();
    for (const tab of tracked) {
      const latestRows = await db
        .select({ dataBlob: snapshots.dataBlob })
        .from(snapshots)
        .where(and(eq(snapshots.tabId, tab.id), ne(snapshots.trigger, "import")))
        .orderBy(desc(snapshots.createdAt))
        .limit(1);
      if (latestRows[0]) latestDataByTab.set(tab.id, decodeSnapshot(latestRows[0].dataBlob));
    }
    const tabData = [...latestDataByTab.entries()].map(([tabId, data]) => {
      const t = tracked.find((x) => x.id === tabId);
      return { title: t?.title ?? tabId, data, keyColumn: t?.keyColumn ?? null };
    });
    const deduped = dedupeTabData(tabData);

    for (const tab of tracked) {
      const latestData = latestDataByTab.get(tab.id) ?? null;
      if (latestData) {
        const checkFindings = runChecks([{ tabTitle: tab.title, data: latestData, keyColumn: tab.keyColumn ?? null }]);
        digest.checkCount += checkFindings.length;
        for (const f of checkFindings.slice(0, 3)) digest.topChecks.push(`${tab.title}: ${f.message}`);
      }

      // a pure compilation tab contributes NOTHING to any digest number —
      // not changes, not footage, not samples: the working tab's own pending
      // already lists that work (this is the same rule the billing page and
      // both CSV exports apply, so the email can never disagree with them)
      if (deduped.pureCopies.has(tab.title)) continue;

      const pending = await getPendingChanges(tab);
      if (!pending || !latestData) continue;
      digest.detail.added += pending.counts.added;
      digest.detail.removed += pending.counts.removed;
      digest.detail.changed += pending.counts.changed;
      digest.unresolved += pending.counts.unresolved;

      // footage delta since collection for this tab — DEDUPED on both sides:
      // the latest walk's ownership is applied to the baseline too, so a
      // compilation tab that copied this tab's rows cannot swing the number
      // (it summed raw per-tab deltas here before and overstated 2x on
      // sheets that track their Line List)
      const nowF = computeFootage({
        headers: latestData.headers,
        rows: deduped.freshByTab.get(tab.title) ?? [],
      });
      const baselineRows = await db
        .select({ dataBlob: snapshots.dataBlob })
        .from(snapshots)
        .where(and(eq(snapshots.tabId, tab.id), eq(snapshots.isBaseline, true), ne(snapshots.trigger, "import")))
        .orderBy(desc(snapshots.createdAt))
        .limit(1);
      if (baselineRows[0]) {
        const baseData = decodeSnapshot(baselineRows[0].dataBlob);
        const baseF = computeFootage({
          headers: baseData.headers,
          rows: deduped.ownedRows(new Map([[tab.title, baseData]])).get(tab.title) ?? [],
        });
        if (nowF.stations && baseF.stations) digest.footageDelta += nowF.ft - baseF.ft;
      }

      for (const row of pending.unresolved) {
        if (digest.sampleChanges.length >= 12) break;
        if (row.status === "added") {
          digest.sampleChanges.push({
            tab: tab.title,
            description: `added: ${row.values.slice(0, 4).filter(Boolean).join(" · ") || "(empty row)"}`,
          });
        } else if (row.status === "removed") {
          digest.sampleChanges.push({
            tab: tab.title,
            description: `removed: ${row.values.slice(0, 4).filter(Boolean).join(" · ") || "(empty row)"}`,
          });
        } else if (row.cells.length > 0) {
          digest.sampleChanges.push({
            tab: tab.title,
            description: row.cells
              .slice(0, 3)
              .map((c) => `${c.header}: ${c.from || "blank"} → ${c.to || "blank"}`)
              .join(" · "),
          });
        }
      }
    }

    digest.changes = digest.detail.added + digest.detail.removed + digest.detail.changed;

    // weekly position: this week's dated footage + WoW + placed/designed/remaining
    // from TOTALS — the numbers Erin actually reports upward on Monday.
    // DEDUPED cross-tab (compilation tabs would double every number) — the
    // same deduped view computed above, so the email's numbers are the
    // billing page's numbers.
    let lastWeekStart: number | null = null;
    const prodTabsFresh: SnapshotData[] = []; // deduped station tabs — the quiet-log clock
    {
      const weeklyByTab: { weeks: ReturnType<typeof weeklyProduction>; placedFt: number }[] = [];
      for (const [title, rows] of deduped.freshByTab) {
        const original = tabData.find((td) => td.title === title);
        if (!original) continue;
        // zero-week guard: a DATED but station-less tab (a log, a tracker) can
        // own the newest date on the sheet while measuring 0 ft — its empty
        // bucket becomes "this week: 0 ft" and buries real production in the
        // prior week. The weekly position comes from station tabs only, the
        // same rule the report page applies.
        if (!detectStationColumns(original.data)) continue;
        const freshData = { headers: original.data.headers, rows };
        if (!deduped.pureCopies.has(title)) prodTabsFresh.push(freshData);
        weeklyByTab.push({ weeks: weeklyProduction(freshData), placedFt: 0 });
      }
      if (weeklyByTab.length > 0) {
        const agg = aggregateWeekly(weeklyByTab);
        if (agg.weeks.length > 0) {
          digest.weekFt = agg.weeks[agg.weeks.length - 1]!.ft;
          digest.weekDeltaFt =
            agg.weeks.length > 1 ? agg.weeks[agg.weeks.length - 1]!.ft - agg.weeks[agg.weeks.length - 2]!.ft : null;
          lastWeekStart = agg.weeks[agg.weeks.length - 1]!.weekStart;
        }
      }
    }

    const allTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id));
    // placed / designed / remaining from a TOTALS-like tab
    let totalsData: SnapshotData | null = null;
    {
      const totalsTab = allTabs.find((t) => /totals?|summary/i.test(t.title) && t.tracked);
      if (totalsTab) {
        const totalsSnap = (
          await db
            .select()
            .from(snapshots)
            .where(and(eq(snapshots.tabId, totalsTab.id), ne(snapshots.trigger, "import")))
            .orderBy(desc(snapshots.createdAt))
            .limit(1)
        )[0];
        if (totalsSnap) {
          const totals = decodeSnapshot(totalsSnap.dataBlob);
          totalsData = totals;
          const over = detectOverplacement(totals, 0);
          // infer designed/placed from the TOTALS structure: sum the Designed
          // and Placed columns when present
          const designedCol = totals.headers.findIndex((h) => /designed/i.test(h));
          const placedCol = totals.headers.findIndex((h) => /placed/i.test(h) && !/designed/i.test(h));
          if (designedCol >= 0 && placedCol >= 0) {
            let designed = 0;
            let placed = 0;
            for (const row of totals.rows) {
              const d = parseFloat((row[designedCol] ?? "").replace(/[^\d.-]/g, ""));
              const p = parseFloat((row[placedCol] ?? "").replace(/[^\d.-]/g, ""));
              if (Number.isFinite(d)) designed += d;
              if (Number.isFinite(p)) placed += p;
            }
            if (designed > 0) {
              digest.designedFt = Math.round(designed);
              digest.placedFt = Math.round(placed);
              digest.remainingFt = Math.round(Math.max(designed - placed, 0));
            }
          }
          void over; // over-placement is already surfaced by the checks panel
        }
      }
    }

    // permit highlights — the SAME detectors and deduped data the sheet page
    // runs: crossings placed under permits the tracker hasn't approved, and
    // designed footage with no permit path at all. No Permit Tracker = no
    // line in the email (vocabulary-gated, like every other join).
    {
      const candidates = allTabs.filter((t) => isPermitTabTitle(t.title));
      if (candidates.length > 0) {
        const snapsByTab = await latestNonImportSnapshots(candidates.map((t) => t.id));
        const candData: { title: string; data: SnapshotData }[] = [];
        for (const t of candidates) {
          const s = snapsByTab.get(t.id);
          if (s) candData.push({ title: t.title, data: decodeSnapshot(s.dataBlob) });
        }
        const permitTab = detectPermitTab(candData);
        if (permitTab) {
          const workingTabs = tabData.filter((t) => t.title !== permitTab.title);
          const permitFresh = deduped.freshByTab;
          const findings = permitFindings({
            permitTab: permitTab.data,
            totals: totalsData,
            peTabs: workingTabs
              .filter((t) => !deduped.pureCopies.has(t.title))
              .map((t) => ({
                title: t.title,
                data: { headers: t.data.headers, rows: permitFresh.get(t.title) ?? [] },
              })),
          });
          digest.permitCounts = {
            unapprovedCrossings: findings.filter((f) => f.kind === "placed-under-unapproved").length,
            designedNoPermit: findings.filter((f) => f.kind === "designed-no-permit").length,
          };
        }
      }
    }

    // stoppage context for the digest week — the SAME log join the weekly
    // report runs: "N stoppages (reason)" beside this week's footage, plus
    // the quiet-log guard when the log trails the newest completed work.
    {
      const candidates = allTabs.filter((t) => isStoppageTabTitle(t.title));
      if (candidates.length > 0) {
        const snapsByTab = await latestNonImportSnapshots(candidates.map((t) => t.id));
        const candData: { title: string; data: SnapshotData }[] = [];
        for (const t of candidates) {
          const s = snapsByTab.get(t.id);
          if (s) candData.push({ title: t.title, data: decodeSnapshot(s.dataBlob) });
        }
        const stoppageTab = detectStoppageTab(candData);
        if (stoppageTab) {
          const weeks = stoppageWeeks(stoppageTab.data);
          const quiet = quietStoppageLog(weeks, prodTabsFresh);
          const thisWeek = lastWeekStart !== null ? (weeks.get(lastWeekStart) ?? null) : null;
          digest.stoppage = {
            weekCount: thisWeek?.count ?? 0,
            exemplar: thisWeek?.exemplar ?? "",
            quietDaysBehind: quiet ? quiet.daysBehind : null,
          };
        }
      }
    }

    const sheetNotes = await db
      .select()
      .from(notesTable)
      .where(eq(notesTable.spreadsheetId, sheet.id))
      .orderBy(desc(notesTable.createdAt))
      .limit(3);
    digest.notes = sheetNotes.map((n) => ({ body: n.body, when: relativeTime(n.createdAt) }));

    out.push(digest);
  }
  return out;
}

export type DigestSkipReason = "smtp-not-configured" | "no-email" | "no-sheets";
export type DigestSendResult = { sent: true } | { sent: false; reason: DigestSkipReason };

export async function sendDigestTo(user: User): Promise<DigestSendResult> {
  if (!smtpConfigured()) return { sent: false, reason: "smtp-not-configured" };
  if (!user.digestEmail) return { sent: false, reason: "no-email" };
  const sheets = await buildDigestSheets(user.id);
  if (sheets.length === 0) return { sent: false, reason: "no-sheets" };

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const html = await render(DigestEmail({ name: user.name?.split(" ")[0] ?? "", appUrl, sheets }));
  const totalUnresolved = sheets.reduce((n, s) => n + s.unresolved, 0);
  const staleCount = sheets.filter((s) => s.lastSnapshotAgo).length;

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transport.sendMail({
    from: process.env.DIGEST_FROM ?? `SheetDiff <${process.env.SMTP_USER}>`,
    to: user.digestEmail,
    subject:
      // staleness outranks the count: a count computed from data the app
      // itself flags as stale must not be the headline
      staleCount > 0
        ? `SheetDiff: ⚠ ${staleCount} sheet${staleCount === 1 ? "" : "s"} may be stale${totalUnresolved > 0 ? ` · ${totalUnresolved} to enter` : ""}`
        : totalUnresolved > 0
          ? `SheetDiff: ${totalUnresolved} change${totalUnresolved === 1 ? "" : "s"} to enter`
          : "SheetDiff: all sheets up to date",
    html,
  });
  return { sent: true };
}

/** All users due for their digest right now (checked every scheduler tick). */
export async function usersDueForDigest(now = Date.now()): Promise<User[]> {
  const rows = await db.select().from(users);
  const d = new Date(now);
  return rows.filter((u) => {
    if (!u.digestEmail) return false;
    // weekly cadence: only due on the chosen weekday (null = daily)
    if (u.digestDay !== null && u.digestDay !== undefined && d.getDay() !== u.digestDay) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(u.digestTime ?? "07:00");
    if (!m) return false;
    const due = new Date(now);
    due.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (now < due.getTime()) return false;
    const last = u.lastDigestAt ?? 0;
    // already sent today (or, for weekly, within the last 6 days)?
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    if (u.digestDay !== null && u.digestDay !== undefined) {
      return now - last > 6 * 24 * 3_600_000;
    }
    return last < todayStart.getTime();
  });
}
