import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { spreadsheets, tabs, snapshots, changeAcks, notes as notesTable, users, type User } from "./db/schema";
import { decodeSnapshot } from "./snapshots";
import { diffSnapshots } from "./diff/engine";
import { runChecks, computeFootage } from "./checks";
import { isResolved } from "./sync";
import { DigestEmail, type DigestSheet } from "./emails/digest";
import { relativeTime } from "./format";

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** Assemble the digest content for one user's sheets. */
export async function buildDigestSheets(userId: string): Promise<DigestSheet[]> {
  const sheets = await db
    .select()
    .from(spreadsheets)
    .where(eq(spreadsheets.userId, userId))
    .orderBy(desc(spreadsheets.createdAt));

  const out: DigestSheet[] = [];
  for (const sheet of sheets) {
    const sheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id));
    const tracked = sheetTabs.filter((t) => t.tracked);
    if (tracked.length === 0) continue;

    const all = await db
      .select()
      .from(snapshots)
      .where(inArray(snapshots.tabId, tracked.map((t) => t.id)))
      .orderBy(desc(snapshots.createdAt));

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
    };

    for (const tab of tracked) {
      const tabSnaps = all.filter((s) => s.tabId === tab.id && s.trigger !== "import");
      if (tabSnaps.length === 0) continue;
      const latest = tabSnaps[0];
      const baseline = tabSnaps.find((s) => s.isBaseline && s.createdAt <= latest.createdAt) ?? null;

      // checks on the latest snapshot
      const checkFindings = runChecks([
        { tabTitle: tab.title, data: decodeSnapshot(latest.dataBlob), keyColumn: tab.keyColumn ?? null },
      ]);
      digest.checkCount += checkFindings.length;
      for (const f of checkFindings.slice(0, 3)) digest.topChecks.push(`${tab.title}: ${f.message}`);

      if (!baseline || baseline.id === latest.id) continue;
      const diff = diffSnapshots(decodeSnapshot(baseline.dataBlob), decodeSnapshot(latest.dataBlob), {
        keyColumn: tab.keyColumn ?? null,
        fromWhen: baseline.createdAt,
        toWhen: latest.createdAt,
      });

      // footage delta since collection for this tab
      const nowF = computeFootage(decodeSnapshot(latest.dataBlob));
      const baseF = computeFootage(decodeSnapshot(baseline.dataBlob));
      if (nowF.stations) digest.footageDelta += nowF.ft - baseF.ft;
      digest.detail.added += diff.summary.addedRows;
      digest.detail.removed += diff.summary.removedRows;
      digest.detail.changed += diff.summary.changedRows;

      const ackRows = await db.select().from(changeAcks).where(eq(changeAcks.tabId, tab.id));
      const ackMap = new Map(ackRows.map((a) => [a.rowKey, a.ackedAt]));
      for (const row of diff.rows) {
        if (row.status === "unchanged" || row.status === "moved") continue;
        if (!isResolved(ackMap, row.rowKey, latest.createdAt)) digest.unresolved++;
        if (digest.sampleChanges.length < 12) {
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

export async function sendDigestTo(user: User): Promise<{ sent: boolean; reason?: string }> {
  if (!smtpConfigured()) return { sent: false, reason: "smtp-not-configured" };
  if (!user.digestEmail) return { sent: false, reason: "no-email" };
  const sheets = await buildDigestSheets(user.id);
  if (sheets.length === 0) return { sent: false, reason: "no-sheets" };

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const html = await render(
    DigestEmail({ name: user.name?.split(" ")[0] ?? "", appUrl, sheets }),
  );
  const totalUnresolved = sheets.reduce((n, s) => n + s.unresolved, 0);

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
        : "SheetDiff: all sheets up to date",
    html,
  });
  return { sent: true };
}

/** All users due for their digest right now (checked every scheduler tick). */
export async function usersDueForDigest(now = Date.now()): Promise<User[]> {
  const rows = await db.select().from(users);
  return rows.filter((u) => {
    if (!u.digestEmail) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(u.digestTime ?? "07:00");
    if (!m) return false;
    const due = new Date(now);
    due.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (now < due.getTime()) return false;
    const last = u.lastDigestAt ?? 0;
    // already sent today?
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    return last < todayStart.getTime();
  });
}
