import type { SnapshotData } from "./diff/engine";
import { norm } from "./diff/normalize";
import { detectStationColumns, detectActivityColumn, parseStation, isFootageChainRow } from "./detect";

/**
 * Production-domain analytics beyond the chain: crew productivity, TOTALS-tab
 * reconciliation, aging gap ledger, backdated-entry detection. All pure —
 * the sheet page and digest feed them snapshots.
 */

const DATE_HEADER_RE = /date\s*complete|complete[d]?\s*date|^date$/i;
const CREW_HEADER_RE = /^crew|^crew\s*#|crew\s*name/i;

/** Column whose header names the completion date, or null. */
export function detectDateColumn(data: SnapshotData): number | null {
  for (let i = 0; i < data.headers.length; i++) {
    if (DATE_HEADER_RE.test(norm(data.headers[i]))) return i;
  }
  return null;
}

/** Column whose header names the crew, or null. */
export function detectCrewColumn(data: SnapshotData): number | null {
  for (let i = 0; i < data.headers.length; i++) {
    if (CREW_HEADER_RE.test(norm(data.headers[i]))) return i;
  }
  return null;
}

/** Parse the completion-date formats crews actually type. */
export function parseCompletedDate(value: unknown): Date | null {
  const t = norm(value);
  if (t === "") return null;
  // ISO-ish (exceljs Dates are pre-serialized to this by the importer)
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // US numeric: 7/14, 07/14/2026, 7-14-26
  const us = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(t);
  if (us) {
    const now = new Date();
    const year = us[3] ? Number(us[3].length === 2 ? `20${us[3]}` : us[3]) : now.getFullYear();
    const d = new Date(year, Number(us[1]) - 1, Number(us[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  // "May 28 2026" / "Thu May 28 2026" (JS Date stringification from exceljs)
  const parsed = new Date(t);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1990 && parsed.getFullYear() < 2100) {
    return parsed;
  }
  return null;
}

export interface DateHygieneFinding {
  row: number;
  kind: "undated" | "unreadable" | "future";
  raw: string;
}

/** Date Complete hygiene on footage-chain rows: blank, unreadable, future. */
export function dateHygiene(data: SnapshotData, today = new Date()): DateHygieneFinding[] {
  const dateCol = detectDateColumn(data);
  const stations = detectStationColumns(data);
  const activityCol = detectActivityColumn(data);
  if (dateCol === null || !stations) return [];
  const out: DateHygieneFinding[] = [];
  data.rows.forEach((row, i) => {
    if (!isFootageChainRow(row, activityCol)) return;
    const s = parseStation(row[stations.start]);
    const e = parseStation(row[stations.end]);
    if (s === null || e === null || e <= s) return; // handholes/unparseable aren't footage
    const raw = norm(row[dateCol]);
    if (raw === "") {
      out.push({ row: i + 1, kind: "undated", raw: "" });
      return;
    }
    const d = parseCompletedDate(raw);
    if (d === null) {
      out.push({ row: i + 1, kind: "unreadable", raw });
      return;
    }
    if (d.getTime() > today.getTime() + 36 * 3_600_000) {
      out.push({ row: i + 1, kind: "future", raw });
    }
  });
  return out;
}

export interface LateEntry {
  row: number;
  completedOn: string;
  appearedAt: number;
  daysLate: number;
  activity: string;
}

/**
 * Backdated entries: rows whose completion date is far older than the first
 * snapshot in which they appeared — "new work entered today" vs "old work
 * entered late." `walk` is oldest → newest snapshots of one tab (non-import);
 * a row is LATE when (first-appeared capture − Date Complete) exceeds the
 * tolerance. Default 2 days keeps the legitimate Friday-evening→Monday-morning
 * entry pattern (2.3 days) out of the findings.
 */
export function detectLateEntries(
  walk: { createdAt: number; data: SnapshotData }[],
  toleranceDays = 2,
): LateEntry[] {
  if (walk.length < 2) return [];
  const out: LateEntry[] = [];
  const dateCol = detectDateColumn(walk[walk.length - 1]!.data);
  const activityCol = detectActivityColumn(walk[walk.length - 1]!.data);
  if (dateCol === null) return [];

  for (let k = 1; k < walk.length; k++) {
    const prev = walk[k - 1]!;
    const cur = walk[k]!;
    const prevSet = new Set(prev.data.rows.map((r) => norm(r.join("·")))); // newness check still needs prev
    for (let i = 0; i < cur.data.rows.length; i++) {
      const row = cur.data.rows[i]!;
      if (prevSet.has(norm(row.join("·")))) continue; // not new in this snapshot
      const d = parseCompletedDate(row[dateCol]);
      if (d === null) continue;
      const lateByMs = cur.createdAt - d.getTime();
      const daysLate = Math.floor(lateByMs / 86_400_000);
      if (daysLate > toleranceDays) {
        out.push({
          row: i + 1,
          completedOn: norm(row[dateCol]),
          appearedAt: cur.createdAt,
          daysLate,
          activity: activityCol !== null ? norm(row[activityCol]) : "",
        });
      }
    }
  }
  return out.reverse(); // newest first
}

export interface TotalsMismatch {
  tabTitle: string;
  totalsSays: number;
  tabAddsUp: number;
  delta: number;
}

/**
 * Reconcile the TOTALS tab against the PE tabs' own math. totalsData rows
 * carry the PE name in some cell and its footage in the nearest numeric cell;
 * perTabFootage is the computed footage per tab title.
 */
export function reconcileTotals(
  totalsData: SnapshotData,
  perTabFootage: Map<string, number>,
  toleranceFt = 1,
): TotalsMismatch[] {
  const out: TotalsMismatch[] = [];
  for (const row of totalsData.rows) {
    const nameCell = row.find((v) => {
      const t = norm(v).toLowerCase();
      return t !== "" && perTabFootage.has(t);
    });
    if (nameCell === undefined) continue;
    const title = norm(nameCell).toLowerCase();
    // nearest numeric cell in the row that isn't the identifier itself
    const nums: number[] = [];
    for (const cell of row) {
      if (cell === nameCell) continue;
      const n = Number(norm(cell).replace(/,/g, ""));
      if (Number.isFinite(n) && norm(cell) !== "") nums.push(n);
    }
    if (nums.length === 0) continue;
    const totalsSays = nums[0]!;
    const addsUp = perTabFootage.get(title)!;
    if (Math.abs(totalsSays - addsUp) > toleranceFt) {
      out.push({ tabTitle: title, totalsSays, tabAddsUp: addsUp, delta: totalsSays - addsUp });
    }
  }
  return out;
}

export interface CrewDay {
  crew: string;
  date: string;
  ft: number;
  shots: number;
}

export interface CrewBoard {
  days: CrewDay[];
  crews: { crew: string; ft: number; shots: number; days: number }[];
  uncategorizedFt: number;
}

/** Per-crew per-day placed footage (the daily report, generated). */
export function computeCrewBoard(data: SnapshotData): CrewBoard {
  const stations = detectStationColumns(data);
  const activityCol = detectActivityColumn(data);
  const crewCol = detectCrewColumn(data);
  const dateCol = detectDateColumn(data);
  const board: CrewBoard = { days: [], crews: [], uncategorizedFt: 0 };
  if (!stations || crewCol === null) return board;

  const dayMap = new Map<string, CrewDay>();
  const crewMap = new Map<string, { ft: number; shots: number; days: Set<string> }>();
  for (const row of data.rows) {
    if (!isFootageChainRow(row, activityCol)) continue;
    const s = parseStation(row[stations.start]);
    const e = parseStation(row[stations.end]);
    if (s === null || e === null || e <= s) continue;
    const ft = e - s;
    const crew = norm(row[crewCol]) || "(no crew)";
    if (crew === "(no crew)") board.uncategorizedFt += ft;
    const dateRaw = dateCol !== null ? parseCompletedDate(row[dateCol]) : null;
    const dateKey = dateRaw ? dateRaw.toISOString().slice(0, 10) : "";
    const day = dayMap.get(`${crew}|${dateKey}`);
    if (day) {
      day.ft += ft;
      day.shots++;
    } else {
      dayMap.set(`${crew}|${dateKey}`, { crew, date: dateKey, ft, shots: 1 });
    }
    const c = crewMap.get(crew);
    if (c) {
      c.ft += ft;
      c.shots++;
      if (dateKey) c.days.add(dateKey);
    } else {
      crewMap.set(crew, { ft, shots: 1, days: new Set(dateKey ? [dateKey] : []) });
    }
  }
  board.days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.crew.localeCompare(b.crew)));
  board.crews = [...crewMap.entries()]
    .map(([crew, c]) => ({ crew, ft: c.ft, shots: c.shots, days: c.days.size }))
    .sort((a, b) => b.ft - a.ft);
  return board;
}

export interface AgingGap {
  from: number;
  to: number;
  ft: number;
  firstSeen: number;
  lastSeen: number;
  daysOpen: number;
}

/**
 * Age every unaccounted hole across a snapshot window: keyed by rounded
 * station range (stable identity, exactly how gaps are re-found), tracked
 * from first sighting to last. `reports` is oldest → newest.
 */
export function agingGaps(
  reports: { createdAt: number; report: { unaccounted: { from: number; to: number; ft: number }[] } }[],
  now = Date.now(),
): AgingGap[] {
  const tracker = new Map<string, AgingGap & { closedAt?: number }>();
  for (const { createdAt, report } of reports) {
    const seen = new Set<string>();
    for (const g of report.unaccounted) {
      const key = `${Math.round(g.from)}-${Math.round(g.to)}`;
      seen.add(key);
      const existing = tracker.get(key);
      if (existing && existing.closedAt === undefined) {
        existing.lastSeen = createdAt;
      } else if (!existing) {
        tracker.set(key, { from: g.from, to: g.to, ft: g.ft, firstSeen: createdAt, lastSeen: createdAt, daysOpen: 0 });
      }
    }
    // holes absent from this snapshot's report are closed
    for (const [key, gap] of tracker) {
      if (!seen.has(key) && gap.closedAt === undefined) gap.closedAt = createdAt;
    }
  }
  const out: AgingGap[] = [];
  for (const g of tracker.values()) {
    if (g.closedAt !== undefined) continue; // only OPEN holes
    g.daysOpen = Math.max(0, Math.floor((now - g.firstSeen) / 86_400_000));
    out.push(g);
  }
  return out.sort((a, b) => b.daysOpen - a.daysOpen || b.ft - a.ft);
}
