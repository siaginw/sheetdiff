import { and, eq, gt, inArray, lt, max, ne } from "drizzle-orm";
import crypto from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { db } from "./db";
import { snapshots, snapshotStats, spreadsheets, tabs, users, type Snapshot, type Spreadsheet } from "./db/schema";
import { diffSnapshots, type DiffResult, type SnapshotData } from "./diff/engine";
import { norm } from "./diff/normalize";
import { fetchTabValues, getUserClient } from "./google";
import { logger } from "./logger";

const gzipAsync = promisify(zlib.gzip);

/**
 * Convert a raw API grid into a stable SnapshotData:
 *  - trailing fully-empty rows are dropped (Sheets pads grids)
 *  - every row is padded to the grid width so columns stay aligned
 *  - row 0 becomes the header row (the product treats first row as headers)
 */
export function toSnapshotData(raw: string[][]): SnapshotData {
  const rows = raw
    .map((r) => r.map((v) => norm(v)))
    // drop fully-empty rows anywhere (Sheets/API omits some, trackers pad
    // hundreds of blank formatted rows) — they carry no data and only add noise
    .filter((r) => r.some((v) => v !== ""));
  // loop, not Math.max(...rows.map()) — the spread blows the call stack on
  // ~130k-row captures (a loud failure, but still a failed capture)
  let width = 1;
  for (const r of rows) if (r.length > width) width = r.length;
  const padded = rows.map((r) => {
    const p = r.slice(0, width);
    while (p.length < width) p.push("");
    return p;
  });
  const headers = padded.shift() ?? [];
  while (headers.length < width) headers.push("");
  return { headers, rows: padded };
}

export function encodeSnapshot(data: SnapshotData): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8"));
}

/** Non-blocking gzip for the capture path (keeps the event loop free). */
export async function encodeSnapshotAsync(data: SnapshotData): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify(data), "utf8"));
}

export function decodeSnapshot(blob: Buffer): SnapshotData {
  return JSON.parse(zlib.gunzipSync(Buffer.from(blob)).toString("utf8")) as SnapshotData;
}

/** Next due time for a sheet's schedule, in epoch ms (null = never). */
export function computeNextRun(sheet: Spreadsheet, from = Date.now()): number | null {
  switch (sheet.scheduleKind) {
    case "off":
      return null;
    case "hourly":
      return from + Math.max(1, sheet.scheduleHours ?? 1) * 3_600_000;
    case "daily":
    case "weekly": {
      const m = /^(\d{1,2}):(\d{2})$/.exec(sheet.scheduleTime ?? "09:00");
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      const d = new Date(from);
      d.setHours(h, min, 0, 0);
      if (sheet.scheduleKind === "daily") {
        if (d.getTime() <= from) d.setDate(d.getDate() + 1);
        return d.getTime();
      }
      const delta = ((sheet.scheduleDay ?? 1) - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + delta);
      if (d.getTime() <= from) d.setDate(d.getDate() + 7);
      return d.getTime();
    }
    default:
      return null;
  }
}

/**
 * Capture one snapshot run: fetch every tracked tab of the spreadsheet and
 * store a gzip'd snapshot per tab, grouped by runId.
 */
type CaptureResult = { runId: string; createdAt: number; tabCount: number; rowCount: number };
const inFlight = new Map<string, Promise<CaptureResult>>();

/** Single-flighted per spreadsheet: a manual click racing the scheduler must
 *  not double-capture (both would diff against the same prev, double-counting
 *  the timeline stats). */
export function captureSnapshot(spreadsheetId: string, trigger: "manual" | "scheduled"): Promise<CaptureResult> {
  const existing = inFlight.get(spreadsheetId);
  if (existing) return existing;
  const run = captureSnapshotInner(spreadsheetId, trigger).finally(() => inFlight.delete(spreadsheetId));
  inFlight.set(spreadsheetId, run);
  return run;
}

async function captureSnapshotInner(
  spreadsheetId: string,
  trigger: "manual" | "scheduled",
): Promise<{ runId: string; createdAt: number; tabCount: number; rowCount: number }> {
  const sheetRows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, spreadsheetId));
  const sheet = sheetRows[0];
  if (!sheet) throw new Error("Spreadsheet not found");

  const trackedTabs = await db
    .select()
    .from(tabs)
    .where(and(eq(tabs.spreadsheetId, sheet.id), eq(tabs.tracked, true)));
  if (trackedTabs.length === 0) throw new Error("No tracked tabs on this spreadsheet");

  const client = await getUserClient(sheet.userId);
  const values = await fetchTabValues(
    client,
    sheet.googleId,
    trackedTabs.map((t) => t.title),
  );

  const runId = crypto.randomUUID();
  const now = Date.now();
  let rowCount = 0;

  // previous non-import snapshot per tab (for capture-time diff stats)
  const prevByTab = new Map<string, SnapshotData>();
  const prevBaseAt = { value: 0 }; // newest previous non-import snapshot across tabs
  for (const [tabId, snap] of await latestNonImportSnapshots(trackedTabs.map((t) => t.id))) {
    prevByTab.set(tabId, decodeSnapshot(snap.dataBlob));
    if (snap.createdAt > prevBaseAt.value) prevBaseAt.value = snap.createdAt;
  }

  const inserts: (typeof snapshots.$inferInsert)[] = [];
  const statsInserts: (typeof snapshotStats.$inferInsert)[] = [];
  for (const tab of trackedTabs) {
    const data = toSnapshotData(values[tab.title] ?? []);
    rowCount += data.rows.length;
    const id = crypto.randomUUID();
    const prev = prevByTab.get(tab.id);
    inserts.push({
      id,
      tabId: tab.id,
      runId,
      trigger,
      isBaseline: !prev, // first-ever snapshot auto-baselines
      rowCount: data.rows.length,
      colCount: data.headers.length,
      dataBlob: await encodeSnapshotAsync(data),
      createdAt: now,
    });
    if (prev) {
      const d = diffSnapshots(prev, data, { keyColumn: tab.keyColumn ?? null });
      statsInserts.push({
        snapshotId: id,
        tabId: tab.id,
        added: d.summary.addedRows,
        removed: d.summary.removedRows,
        changed: d.summary.changedRows,
        createdAt: now,
      });
    }
  }

  // atomic: either the whole run lands with updated schedule state, or nothing.
  // .run() matters: drizzle query builders are lazy; without it the
  // transaction commits having executed nothing.
  db.transaction((tx) => {
    tx.insert(snapshots).values(inserts).run();
    tx.update(spreadsheets)
      .set({
        captureFailStreak: 0,
        lastCaptureError: null,
        lastCaptureErrorAt: null,
        lastSnapshotAt: now,
        nextRunAt: computeNextRun(sheet, now),
      })
      .where(eq(spreadsheets.id, sheet.id))
      .run();
  });
  // stats are an optimization: never let them roll back real snapshots (an
  // upgraded deployment without the new table falls back to on-demand diffs)
  if (statsInserts.length > 0) {
    try {
      db.insert(snapshotStats).values(statsInserts).run();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "[capture] stats materialization skipped");
    }
  }

  // push notification for the OWNER when this capture introduced work to
  // enter (the run's own diff stats, not the unresolved backlog). The very
  // first capture is a baseline — everything is "new" by definition and
  // nobody wants that buzz. A capture right after a GIS IMPORT stays quiet
  // too: its "changes" are the rows the office just imported/entered, and
  // announcing them as new work is exactly backwards. Fire-and-forget: the
  // snapshot is already durably committed, and a slow ntfy endpoint must
  // never add its 5s timeout to the capture (or the scheduler tick).
  try {
    const changes = statsInserts.reduce((n, s) => n + s.added + s.removed + s.changed, 0);
    const firstCapture = prevByTab.size === 0;
    if (changes > 0 && !firstCapture) {
      // the capture's diff base is the previous NON-import snapshot per tab;
      // an import run landed after that base means this capture's "changes"
      // are the just-imported rows
      const importSincePrev =
        (
          await db
            .select({ id: snapshots.id })
            .from(snapshots)
            .where(
              and(
                inArray(
                  snapshots.tabId,
                  trackedTabs.map((t) => t.id),
                ),
                eq(snapshots.trigger, "import"),
                gt(snapshots.createdAt, prevBaseAt.value),
                lt(snapshots.createdAt, now),
              ),
            )
            .limit(1)
        ).length > 0;
      if (!importSincePrev) {
        const owner = (await db.select().from(users).where(eq(users.id, sheet.userId)).limit(1))[0];
        if (owner?.notifyUrl) {
          const { notifyCaptureChanges } = await import("./notify");
          void notifyCaptureChanges({
            notifyUrl: owner.notifyUrl,
            sheetTitle: sheet.title,
            sheetId: sheet.id,
            changes,
          }).catch(() => {
            // notifications are best-effort by contract
          });
        }
      }
    }
  } catch {
    // same contract on the outer path: a push problem is never a capture problem
  }

  return { runId, createdAt: now, tabCount: trackedTabs.length, rowCount };
}

/**
 * Latest non-import snapshot for EACH of the given tabs in ONE query —
 * replaces the per-tab hand-rolled loop that ran 36 sequential queries on
 * every page render and twice inside capture.
 */
export async function latestNonImportSnapshots(tabIds: string[]): Promise<Map<string, Snapshot>> {
  if (tabIds.length === 0) return new Map();
  // SQLite bare-column-with-max: the row returned per group IS the max-createdAt
  // row — one query, one blob per tab, instead of reading the whole history
  const rows: Snapshot[] = await db
    .select()
    .from(snapshots)
    .where(and(inArray(snapshots.tabId, tabIds), ne(snapshots.trigger, "import")))
    .groupBy(snapshots.tabId)
    .having(max(snapshots.createdAt));
  return new Map(rows.map((r) => [r.tabId, r]));
}

/** Load + diff two snapshots of the same tab. */
export async function getTabDiff(
  tabId: string,
  fromSnapshotId: string,
  toSnapshotId: string,
): Promise<DiffResult | null> {
  const rows = await db
    .select()
    .from(snapshots)
    .where(inArray(snapshots.id, [fromSnapshotId, toSnapshotId]));
  let from = rows.find((r) => r.id === fromSnapshotId);
  let to = rows.find((r) => r.id === toSnapshotId);
  if (!from || !to || from.tabId !== tabId || to.tabId !== tabId) return null;
  if (to.createdAt < from.createdAt) {
    [from, to] = [to, from]; // tolerate reversed selection
  }
  const tabRows = await db.select().from(tabs).where(eq(tabs.id, tabId));
  const tab = tabRows[0];
  return diffSnapshots(decodeSnapshot(from.dataBlob), decodeSnapshot(to.dataBlob), {
    keyColumn: tab?.keyColumn ?? null,
    fromWhen: from.createdAt,
    toWhen: to.createdAt,
  });
}

/** Record a capture failure for the health signal — best-effort, never throws
 *  (a health write must not compound a capture failure). Stores the first
 *  line of the error, ~300 chars — never the raw error object (gaxios errors
 *  embed token-exchange bodies). */
export async function recordCaptureFailure(spreadsheetId: string, err: unknown): Promise<void> {
  try {
    const { db } = await import("./db");
    const { spreadsheets: sp } = await import("./db/schema");
    const { eq, sql } = await import("drizzle-orm");
    const msg = String(err instanceof Error ? err.message : err)
      .split("\n")[0]
      .slice(0, 300);
    await db
      .update(sp)
      .set({
        captureFailStreak: sql`${sp.captureFailStreak} + 1`,
        lastCaptureError: msg,
        lastCaptureErrorAt: Date.now(),
      })
      .where(eq(sp.id, spreadsheetId));
  } catch {
    // health writes are best-effort
  }
}
