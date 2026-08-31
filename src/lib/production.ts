import { rowContentKey, type SnapshotData } from "./diff/engine";
import { compositeKey } from "./diff/normalize";
import { norm } from "./diff/normalize";
import { detectStationColumns, detectActivityColumn, parseStation, isFootageChainRow, isGapRow, isAdderRow } from "./detect";

/** Local-calendar day key (never toISOString — that is UTC and shifts days). */
function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

export interface OverplacementFinding {
  tabTitle: string;
  designed: number;
  placed: number;
  overBy: number;
}

/**
 * Over-placement guard: TOTALS rows where Placed exceeds Designed. Footage
 * nobody designed is invoice bait (double-counted rows, stale formulas) — the
 * real tracker carries packages hundreds of feet "over". Both numbers come
 * from the TOTALS tab's own Designed/Placed columns, header-guided like
 * reconcileTotals; with no Designed column there is nothing to judge and the
 * guard stays silent rather than guessing.
 */
export function detectOverplacement(totalsData: SnapshotData, toleranceFt = 1): OverplacementFinding[] {
  const designedCol = totalsData.headers.findIndex((h) => /designed/i.test(norm(h)));
  if (designedCol === -1) return [];
  // same placed-column rule as reconcileTotals, minus the Designed column
  // itself ("Total Conduit Designed" also contains "Total Conduit")
  const placedCol = totalsData.headers.findIndex(
    (h, i) => i !== designedCol && /total.*(placed|conduit)|placed/i.test(norm(h)),
  );
  if (placedCol === -1) return [];
  const out: OverplacementFinding[] = [];
  for (const row of totalsData.rows) {
    const designedRaw = norm(row[designedCol]);
    const placedRaw = norm(row[placedCol]);
    if (designedRaw === "" || placedRaw === "") continue; // not designed / not started — nothing to judge
    const designed = Number(designedRaw.replace(/,/g, ""));
    const placed = Number(placedRaw.replace(/,/g, ""));
    if (!Number.isFinite(designed) || !Number.isFinite(placed)) continue;
    if (placed <= designed + toleranceFt) continue;
    const nameCell = row.find((v, i) => i !== designedCol && i !== placedCol && norm(v) !== "");
    out.push({ tabTitle: norm(nameCell ?? ""), designed, placed, overBy: placed - designed });
  }
  return out.sort((a, b) => b.overBy - a.overBy);
}

export interface CrewDay {
  crew: string;
  date: string;
  ft: number;
  shots: number;
}

export interface CrewBoard {
  days: CrewDay[];
  /** `spellings` = how many hand-typed variants collapsed into this crew
   *  ("BIG M DRILL 1" / "BIGM DRILL1" / "big m drill 1" are one crew). */
  crews: { crew: string; ft: number; shots: number; days: number; spellings?: number }[];
  uncategorizedFt: number;
}

/** Crew identity: the alphanumeric collapse. Crews are hand-typed dozens of
 *  ways — case, spacing and punctuation are spelling, not identity — so
 *  "BIG M DRILL 1", "BIGM DRILL1" and "big m drill 1" all key to "bigmdrill1"
 *  while "HAIDER 1" and "HAIDER 2" stay apart. */
function crewKey(display: string): string {
  return display.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Per-crew per-day placed footage (the daily report, generated). */
export function computeCrewBoard(data: SnapshotData): CrewBoard {
  const stations = detectStationColumns(data);
  const activityCol = detectActivityColumn(data);
  const crewCol = detectCrewColumn(data);
  const dateCol = detectDateColumn(data);
  const board: CrewBoard = { days: [], crews: [], uncategorizedFt: 0 };
  if (!stations || crewCol === null) return board;

  type DayAcc = { crewKey: string; date: string; ft: number; shots: number };
  const dayMap = new Map<string, DayAcc>();
  const crewMap = new Map<string, { ft: number; shots: number; days: Set<string> }>();
  const spellCounts = new Map<string, Map<string, number>>(); // crew key -> spelling -> times typed
  for (const row of data.rows) {
    if (!isFootageChainRow(row, activityCol)) continue;
    const s = parseStation(row[stations.start]);
    const e = parseStation(row[stations.end]);
    if (s === null || e === null || e <= s) continue;
    const ft = e - s;
    const crewDisplay = norm(row[crewCol]);
    if (crewDisplay === "") {
      // no crew named: counted once as uncategorized, never a phantom "" crew
      board.uncategorizedFt += ft;
      continue;
    }
    const key = crewKey(crewDisplay);
    const counts = spellCounts.get(key) ?? new Map<string, number>();
    counts.set(crewDisplay, (counts.get(crewDisplay) ?? 0) + 1);
    spellCounts.set(key, counts);
    const dateRaw = dateCol !== null ? parseCompletedDate(row[dateCol]) : null;
    const dateKey = dateRaw ? localDayKey(dateRaw) : "";
    const day = dayMap.get(`${key}|${dateKey}`);
    if (day) {
      day.ft += ft;
      day.shots++;
    } else {
      dayMap.set(`${key}|${dateKey}`, { crewKey: key, date: dateKey, ft, shots: 1 });
    }
    const c = crewMap.get(key);
    if (c) {
      c.ft += ft;
      c.shots++;
      if (dateKey) c.days.add(dateKey);
    } else {
      crewMap.set(key, { ft, shots: 1, days: new Set(dateKey ? [dateKey] : []) });
    }
  }
  // display the spelling the crew actually types most (ties: first seen) —
  // the board reads like the sheet, not like a hash
  const displayFor = new Map<string, { crew: string; spellings: number }>();
  for (const [key, counts] of spellCounts) {
    let best = "";
    let bestN = -1;
    for (const [spelling, n] of counts) {
      if (n > bestN) {
        best = spelling;
        bestN = n;
      }
    }
    displayFor.set(key, { crew: best, spellings: counts.size });
  }
  board.days = [...dayMap.values()]
    .map(({ crewKey, ...d }) => ({ crew: displayFor.get(crewKey)?.crew ?? crewKey, ...d }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.crew.localeCompare(b.crew)));
  board.crews = [...crewMap.entries()]
    .map(([key, c]) => ({
      crew: displayFor.get(key)?.crew ?? key,
      ft: c.ft,
      shots: c.shots,
      days: c.days.size,
      spellings: displayFor.get(key)?.spellings ?? 1,
    }))
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

/* ------------------------------------------------------------------ */
/* office pipeline — the sheet's own "entered downstream" column        */
/* ------------------------------------------------------------------ */

const OFFICE_ENTERED_RE = /entered.*(ineight|in\s*eight|office|system|downstream)|entered\s+down/i;

export interface OfficePipelineRow {
  row: number;
  activity: string;
  completedOn: string;
  daysWaiting: number;
}

export interface OfficePipeline {
  /** the detected "entered downstream" column header, or null when the tab
   *  doesn't track one (the whole feature no-ops silently, like date
   *  detection — a different firm's column vocabulary must never break it) */
  enteredColumn: string | null;
  /** completed-but-unentered footage-chain rows, bucketed by age */
  normal: OfficePipelineRow[]; // 0–2 days: ordinary keying lag
  aging: OfficePipelineRow[]; // 3–7 days: worth a nudge
  stuck: OfficePipelineRow[]; // 15+ days: almost certainly forgotten
}

/** Read the tracker's own record of what the office has already entered: a
 *  dated column the office fills in by hand, independent of SheetDiff's ack
 *  layer. Rows completed but still blank there are the real backlog — and a
 *  stuck bucket here is a signal acks can never give. */
export function officePipeline(data: SnapshotData, now = Date.now()): OfficePipeline {
  const out: OfficePipeline = { enteredColumn: null, normal: [], aging: [], stuck: [] };
  let enteredCol: number | null = null;
  for (let i = 0; i < data.headers.length; i++) {
    if (OFFICE_ENTERED_RE.test(norm(data.headers[i]))) {
      enteredCol = i;
      out.enteredColumn = norm(data.headers[i]);
      break;
    }
  }
  if (enteredCol === null) return out;
  const dateCol = detectDateColumn(data);
  if (dateCol === null) return out;
  const activityCol = detectActivityColumn(data);

  data.rows.forEach((r, i) => {
    if (norm(r[enteredCol!]) !== "") return; // already entered downstream
    if (!isFootageChainRow(r, activityCol) || isGapRow(r, activityCol)) return; // proposed/structure/GAP-placeholder rows aren't office work
    const d = parseCompletedDate(r[dateCol]);
    if (d === null) return; // not complete yet (or unreadable — hygiene owns that)
    const days = Math.floor((now - d.getTime()) / 86_400_000);
    const entry: OfficePipelineRow = {
      row: i + 1,
      activity: activityCol !== null ? norm(r[activityCol]) : "",
      completedOn: norm(r[dateCol]),
      daysWaiting: days,
    };
    if (days >= 15) out.stuck.push(entry);
    else if (days >= 3) out.aging.push(entry);
    else out.normal.push(entry);
  });
  const byAge = (a: OfficePipelineRow, b: OfficePipelineRow) => b.daysWaiting - a.daysWaiting;
  out.stuck.sort(byAge);
  out.aging.sort(byAge);
  return out;
}

/* ------------------------------------------------------------------ */
/* weekly production — the one-pager numbers                           */
/* ------------------------------------------------------------------ */

export interface WeekBucket {
  /** Monday of the week (local calendar), epoch ms */
  weekStart: number;
  ft: number;
  shots: number;
}

/** Footage per calendar week from Date Complete — the management view. All
 *  from ONE snapshot (no history needed): a row lands in the week it says it
 *  was completed, which is exactly how the office talks about progress.
 *  Late-entered rows shift retroactively; callers should label the series
 *  "as dated" and surface late entries alongside. */
export function weeklyProduction(data: SnapshotData): WeekBucket[] {
  const dateCol = detectDateColumn(data);
  if (dateCol === null) return [];
  const activityCol = detectActivityColumn(data);
  const stations = detectStationColumns(data);
  const byWeek = new Map<number, WeekBucket>();
  for (const r of data.rows) {
    if (stations) {
      const s = parseStation(r[stations.start]);
      const e = parseStation(r[stations.end]);
      if (s === null || e === null || e < s) continue; // not a footage row we can measure
    } else if (!isFootageChainRow(r, activityCol)) continue;
    if (isAdderRow(r, activityCol)) continue; // billing overlay
    if (isGapRow(r, activityCol)) continue; // unworked span
    const d = parseCompletedDate(r[dateCol]);
    if (d === null) continue;
    const ft = stations ? Math.max(
      parseStation(r[stations.end])! - parseStation(r[stations.start])!,
      0,
    ) : 0;
    if (stations && ft === 0) continue; // handholes/structures: counted, not footage
    // local-calendar Monday
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (day.getDay() + 6) % 7; // Monday = 0
    const monday = day.getTime() - dow * 86_400_000;
    const bucket = byWeek.get(monday) ?? { weekStart: monday, ft: 0, shots: 0 };
    bucket.ft += ft;
    bucket.shots += 1;
    byWeek.set(monday, bucket);
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart - b.weekStart);
}
