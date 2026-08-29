import crypto from "node:crypto";
import zlib from "node:zlib";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { spreadsheets, tabs, snapshots, type Spreadsheet } from "./db/schema";
import { getUserClient, fetchTabValues } from "./google";
import { diffSnapshots, type SnapshotData, type DiffResult } from "./diff/engine";
import { norm } from "./diff/normalize";

/**
 * Convert a raw API grid into a stable SnapshotData:
 *  - trailing fully-empty rows are dropped (Sheets pads grids)
 *  - every row is padded to the grid width so columns stay aligned
 *  - row 0 becomes the header row (the product treats first row as headers)
 */
export function toSnapshotData(raw: string[][]): SnapshotData {
  const rows = raw.map((r) => r.map((v) => norm(v)));
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  const width = Math.max(1, ...rows.map((r) => r.length));
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
export async function captureSnapshot(
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
  const inserts = trackedTabs.map((tab) => {
    const data = toSnapshotData(values[tab.title] ?? []);
    rowCount += data.rows.length;
    return {
      id: crypto.randomUUID(),
      tabId: tab.id,
      runId,
      trigger,
      isBaseline: false as const,
      rowCount: data.rows.length,
      colCount: data.headers.length,
      dataBlob: encodeSnapshot(data),
      createdAt: now,
    };
  });

  // atomic: either the whole run lands with updated schedule state, or nothing
  await db.transaction((tx) => {
    tx.insert(snapshots).values(inserts);
    tx
      .update(spreadsheets)
      .set({ lastSnapshotAt: now, nextRunAt: computeNextRun(sheet, now) })
      .where(eq(spreadsheets.id, sheet.id));
  });

  return { runId, createdAt: now, tabCount: trackedTabs.length, rowCount };
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
