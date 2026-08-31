import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "./db";
import { tabs, snapshots, notes as notesTable, users, type User } from "./db/schema";
import { decodeSnapshot } from "./snapshots";
import { runChecks, computeFootage } from "./checks";
import { getPendingChanges } from "./pending";
import { listAccessibleSpreadsheets } from "./access";
import { DigestEmail, type DigestSheet } from "./emails/digest";
import { relativeTime } from "./format";
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
    const sheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id));
    const tracked = sheetTabs.filter((t) => t.tracked);
    if (tracked.length === 0) continue;

    const digest: DigestSheet = {
      title: sheet.title,
      url: sheet.url,
      changes: 0,
      detail: { added: 0, removed: 0, changed: 0 },
      unresolved: 0,
      sampleChanges: [],
      checkCount: 0,
      topChecks: [],
      notes: [],
      footageDelta: 0,
      lastSnapshotAgo: null,
      paused: sheet.scheduleKind === "off",
    };
    // staleness signal: after 3x the hourly window / 48h daily / 8d weekly,
    // consecutive captures have been missed — "all up to date" computed from
    // stale data is a lie. Paused sheets are exempt (not capturing by choice).
    if (sheet.lastSnapshotAt && captureIsStale(sheet, now)) {
      digest.lastSnapshotAgo = relativeTime(sheet.lastSnapshotAt);
    }

    for (const tab of tracked) {
      // latest SHEET snapshot (GIS imports excluded) for checks + footage
      const latestRows = await db
        .select({ dataBlob: snapshots.dataBlob })
        .from(snapshots)
        .where(and(eq(snapshots.tabId, tab.id), ne(snapshots.trigger, "import")))
        .orderBy(desc(snapshots.createdAt))
        .limit(1);
      const latestData = latestRows[0] ? decodeSnapshot(latestRows[0].dataBlob) : null;
      if (latestData) {
        const checkFindings = runChecks([
          { tabTitle: tab.title, data: latestData, keyColumn: tab.keyColumn ?? null },
        ]);
        digest.checkCount += checkFindings.length;
        for (const f of checkFindings.slice(0, 3)) digest.topChecks.push(`${tab.title}: ${f.message}`);
      }

      const pending = await getPendingChanges(tab);
      if (!pending || !latestData) continue;
      digest.detail.added += pending.counts.added;
      digest.detail.removed += pending.counts.removed;
      digest.detail.changed += pending.counts.changed;
      digest.unresolved += pending.counts.unresolved;

      // footage delta since collection for this tab
      const nowF = computeFootage(latestData);
      const baselineRows = await db
        .select({ dataBlob: snapshots.dataBlob })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.tabId, tab.id),
            eq(snapshots.isBaseline, true),
            ne(snapshots.trigger, "import"),
          ),
        )
        .orderBy(desc(snapshots.createdAt))
        .limit(1);
      if (baselineRows[0]) {
        const baseF = computeFootage(decodeSnapshot(baselineRows[0].dataBlob));
        if (nowF.stations && baseF.stations) digest.footageDelta += nowF.ft - baseF.ft;
      }

      for (const row of pending.unresolved) {
        if (digest.sampleChanges.length >= 12) break;
        if (row.status === "added") {
          digest.sampleChanges.push({ tab: tab.title, description: `added: ${row.values.slice(0, 4).filter(Boolean).join(" · ") || "(empty row)"}` });
        } else if (row.status === "removed") {
          digest.sampleChanges.push({ tab: tab.title, description: `removed: ${row.values.slice(0, 4).filter(Boolean).join(" · ") || "(empty row)"}` });
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
  const html = await render(
    DigestEmail({ name: user.name?.split(" ")[0] ?? "", appUrl, sheets }),
  );
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
      totalUnresolved > 0
        ? `SheetDiff: ${totalUnresolved} change${totalUnresolved === 1 ? "" : "s"} to collect`
        : staleCount > 0
          ? `SheetDiff: ⚠ ${staleCount} sheet${staleCount === 1 ? "" : "s"} may be stale`
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
