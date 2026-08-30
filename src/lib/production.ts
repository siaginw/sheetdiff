import { rowContentKey, type SnapshotData } from "./diff/engine";
import { compositeKey } from "./diff/normalize";
import { norm, normalizeKey } from "./diff/normalize";

/** Local-calendar day key (never toISOString — that is UTC and shifts days). */
function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
import { detectStationColumns, detectActivityColumn, parseStation, isFootageChainRow, isGapRow } from "./detect";

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

/** Parse the completion-date formats crews actually type. Rollover is NEVER
 *  silent: "14/07/2026" (day-first) or "6/31/26" return null and surface as
 *  "unreadable" hygiene findings instead of landing in the wrong month. */
export function parseCompletedDate(value: unknown): Date | null {
  const t = norm(value);
  if (t === "") return null;
  const build = (y: number, m: number, d: number): Date | null => {
    // month is 1-based here; JS rolls over silently — validate explicitly
    if (m < 1 || m > 12) return null;
    if (y < 1990 || y > 2100) return null;
    const dim = new Date(y, m, 0).getDate(); // days in month
    if (d < 1 || d > dim) return null;
    return new Date(y, m - 1, d);
  };
  // ISO-ish (exceljs Dates are pre-serialized to this by the importer)
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  // US numeric: 7/14, 07/14/2026, 7-14-26 (M/D order — a day-first entry with
  // month > 12 returns null rather than silently swapping)
  const us = /^(\d{1,2})[\/ -](\d{1,2})(?:[\/ -](\d{2,4}))?$/.exec(t);
  if (us) {
    const now = new Date();
    const yy = us[3] ? Number(us[3].length === 2 ? `20${us[3]}` : us[3]) : now.getFullYear();
    return build(yy, Number(us[1]), Number(us[2]));
  }
  // "May 28 2026" / "Thu May 28 2026" (JS Date stringification from exceljs)
  const parsed = new Date(t);
  if (!isNaN(parsed.getTime())) {
    // "Thu May 28 2026 19:00:00" carries a time — compare the CALENDAR day,
    // and return midnight-normalized so downstream day keys are stable
    const b = build(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
    return b;
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
    if (isGapRow(row, activityCol)) return; // booked holes never have completion dates
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
 * entered late." A row EDITED in a later snapshot (crew name fixed, etc.) is
 * NOT late: first appearance is tracked across the whole walk via the shared
 * rowContentKey identity, not adjacent-snapshot membership.
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

  // "New work" = a work identity (Activity + stations composite) never seen in
  // any earlier snapshot. An EDITED row keeps its composite identity, so a
  // supervisor fixing a crew name weeks later is never a late entry.
  // identity columns from the LAST snapshot (activity + stations, ungated —
  // this is identity, not duplicate detection; single-row tabs included)
  const ref = walk[walk.length - 1]!.data;
  const refSt = detectStationColumns(ref);
  const refAct = detectActivityColumn(ref);
  const compositeCols: number[] | null = refSt && refAct !== null ? [refAct, refSt.start, refSt.end] : null;
  const identityOf = (row: string[]): string =>
    compositeCols ? compositeKey(row, compositeCols) : rowContentKey(row);
  const seenEver = new Set<string>();
  for (const row of walk[0]!.data.rows) seenEver.add(identityOf(row));
  for (let k = 1; k < walk.length; k++) {
    const cur = walk[k]!;
    for (let i = 0; i < cur.data.rows.length; i++) {
      const row = cur.data.rows[i]!;
      const identity = identityOf(row);
      if (seenEver.has(identity)) continue; // edited, moved, or unchanged — not new
      const d = parseCompletedDate(row[dateCol]);
      if (d === null) continue;
      const daysLate = Math.floor((cur.createdAt - d.getTime()) / 86_400_000);
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
    for (const row of cur.data.rows) seenEver.add(identityOf(row));
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
 * Reconcile the TOTALS tab against the PE tabs' own math. The compared cell is
 * chosen by HEADER (e.g. "Total Conduit Placed") when one matches — first-
 * numeric grabs the wrong column on real trackers. A row agrees when ANY of
 * its numeric cells is within tolerance; rows with a blank placed cell (work
 * not started) are skipped.
 */
export function reconcileTotals(
  totalsData: SnapshotData,
  perTabFootage: Map<string, { title: string; ft: number }>,
  toleranceFt = 1,
): TotalsMismatch[] {
  const out: TotalsMismatch[] = [];
  const byLower = new Map([...perTabFootage].map(([k, v]) => [k.toLowerCase(), v]));

  // header-guided numeric column (falls back to any numeric cell)
  const placedCol = totalsData.headers.findIndex((h) =>
    /total.*(placed|conduit)|placed/i.test(norm(h)),
  );

  for (const row of totalsData.rows) {
    const nameCell = row.find((v) => {
      const t = norm(v).toLowerCase();
      return t !== "" && byLower.has(t);
    });
    if (nameCell === undefined) continue;
    const entry = byLower.get(norm(nameCell).toLowerCase())!;

    const nums: number[] = [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === nameCell) continue;
      const n = Number(norm(row[c]).replace(/,/g, ""));
      if (Number.isFinite(n) && norm(row[c]) !== "") nums.push(n);
    }
    if (nums.length === 0) continue;
    const placedNums = placedCol >= 0 && Number.isFinite(Number(norm(row[placedCol]).replace(/,/g, "")))
      ? [Number(norm(row[placedCol]).replace(/,/g, ""))]
      : nums;
    if (placedNums.length === 1 && norm(row[placedCol] ?? "") === "") continue; // not started

    const agrees = placedNums.some((n) => Math.abs(n - entry.ft) <= toleranceFt);
    if (agrees) continue;
    const totalsSays = placedNums[0]!;
    out.push({ tabTitle: entry.title, totalsSays, tabAddsUp: entry.ft, delta: totalsSays - entry.ft });
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
  const crewDisplayFor = new Map<string, string>(); // normalized key -> first-seen casing
  const crewMap = new Map<string, { ft: number; shots: number; days: Set<string>; display: string }>();
  for (const row of data.rows) {
    if (!isFootageChainRow(row, activityCol)) continue;
    const s = parseStation(row[stations.start]);
    const e = parseStation(row[stations.end]);
    if (s === null || e === null || e <= s) continue;
    const ft = e - s;
    // crews are hand-typed: "PPC PLOW" / "PPC Plow" / "BigM P1" are one crew
    const crewDisplay = norm(row[crewCol]);
    const crew = crewDisplay === "" ? "(no crew)" : normalizeKey(crewDisplay);
    if (crew === "(no crew)") board.uncategorizedFt += ft;
    const shown = crewDisplayFor.get(crew) ?? crewDisplay;
    crewDisplayFor.set(crew, shown);
    const dateRaw = dateCol !== null ? parseCompletedDate(row[dateCol]) : null;
    const dateKey = dateRaw ? localDayKey(dateRaw) : "";
    const day = dayMap.get(`${crew}|${dateKey}`);
    if (day) {
      day.ft += ft;
      day.shots++;
    } else {
      dayMap.set(`${crew}|${dateKey}`, { crew: shown, date: dateKey, ft, shots: 1 });
    }
    const c = crewMap.get(crew);
    if (c) {
      c.ft += ft;
      c.shots++;
      if (dateKey) c.days.add(dateKey);
    } else {
      crewMap.set(crew, { ft, shots: 1, days: new Set(dateKey ? [dateKey] : []), display: shown });
    }
  }
  board.days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.crew.localeCompare(b.crew)));
  board.crews = [...crewMap.values()]
    .map((c) => ({ crew: c.display, ft: c.ft, shots: c.shots, days: c.days.size }))
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
  const tracker = new Map<string, AgingGap>();
  for (const { createdAt, report } of reports) {
    const seen = new Set<string>();
    for (const g of report.unaccounted) {
      const key = `${Math.round(g.from)}-${Math.round(g.to)}`;
      seen.add(key);
      const existing = tracker.get(key);
      if (existing && existing.daysOpen !== -1) {
        existing.lastSeen = createdAt; // still open
      } else if (existing) {
        // REOPENED after closing: aging restarts from today, honestly
        Object.assign(existing, { firstSeen: createdAt, lastSeen: createdAt, daysOpen: 0 });
      } else {
        // first sighting — or a REOPEN after the hole closed: aging restarts
        tracker.set(key, { from: g.from, to: g.to, ft: g.ft, firstSeen: createdAt, lastSeen: createdAt, daysOpen: 0 });
      }
    }
    // holes absent from this report closed as of this snapshot
    for (const [key, gap] of tracker) {
      if (!seen.has(key)) gap.daysOpen = -1; // closed marker
    }
  }
  const out: AgingGap[] = [];
  for (const g of tracker.values()) {
    if (g.daysOpen === -1) continue; // closed as of the latest report
    g.daysOpen = Math.max(0, Math.floor((now - g.firstSeen) / 86_400_000));
    out.push(g);
  }
  return out.sort((a, b) => b.daysOpen - a.daysOpen || b.ft - a.ft);
}
