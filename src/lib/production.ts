import { dedupeTabData } from "./dedupe";
import {
  detectActivityColumn,
  detectStationColumns,
  isAdderRow,
  isFootageChainRow,
  isGapRow,
  parseStation,
} from "./detect";
import { rowContentKey, type SnapshotData } from "./diff/engine";
import { compositeKey, norm } from "./diff/normalize";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

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
  // "May 28 2026" / "Thu Feb 30 2026" / "28 May 2026" (JS Date stringification
  // from exceljs, typed by hand). V8 silently rolls impossible days into the
  // next month ("Feb 30" -> Mar 2), which would mis-age A/R by days and shift
  // weekly buckets — extract the literal month name + day and revalidate.
  const tok = (s: string) => MONTHS.findIndex((n) => n.startsWith(s) || s.startsWith(n));
  const mn = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(t);
  if (mn) {
    const m = tok(mn[1]!.toLowerCase());
    if (m >= 0) return build(Number(mn[3]), m + 1, Number(mn[2]));
  }
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9}),?\s+(\d{4})\b/i.exec(t);
  if (dm) {
    const m = tok(dm[2]!.toLowerCase());
    if (m >= 0) return build(Number(dm[3]), m + 1, Number(dm[1]));
  }
  const parsed = new Date(t);
  if (!isNaN(parsed.getTime())) {
    // "Thu May 28 2026 19:00:00" carries a time — compare the CALENDAR day,
    // and return midnight-normalized so downstream day keys are stable
    return build(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
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
export function detectLateEntries(walk: { createdAt: number; data: SnapshotData }[], toleranceDays = 2): LateEntry[] {
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
  const identityOf = (row: string[]): string => (compositeCols ? compositeKey(row, compositeCols) : rowContentKey(row));
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
  const placedCol = totalsData.headers.findIndex((h) => /total.*(placed|conduit)|placed/i.test(norm(h)));

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
    const placedNums =
      placedCol >= 0 && Number.isFinite(Number(norm(row[placedCol]).replace(/,/g, "")))
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
      // exact range, never rounded — fractional-station holes (101.5-203.25
      // vs 101-203) are different holes and must not merge identities
      const key = `${g.from}|${g.to}`;
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
    if (!isFootageChainRow(r, activityCol)) continue; // same chain rule as the ledger and the gap report
    if (stations) {
      const s = parseStation(r[stations.start]);
      const e = parseStation(r[stations.end]);
      if (s === null || e === null || e < s) continue; // not a footage row we can measure
    }
    if (isAdderRow(r, activityCol)) continue; // billing overlay
    if (isGapRow(r, activityCol)) continue; // unworked span
    const d = parseCompletedDate(r[dateCol]);
    if (d === null) continue;
    const ft = stations ? Math.max(parseStation(r[stations.end])! - parseStation(r[stations.start])!, 0) : 0;
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

/** Aggregate weekly buckets across a sheet's tracked tabs (the report page's
 *  numbers): weeks merged ascending, plus the placed total. Pure, so the
 *  one-pager's math is testable without rendering it. */
export function aggregateWeekly(tabs: { weeks: WeekBucket[]; placedFt: number }[]): {
  weeks: WeekBucket[];
  placedFt: number;
} {
  const byWeek = new Map<number, WeekBucket>();
  let placedFt = 0;
  for (const t of tabs) {
    placedFt += t.placedFt;
    for (const w of t.weeks) {
      const bucket = byWeek.get(w.weekStart) ?? { weekStart: w.weekStart, ft: 0, shots: 0 };
      bucket.ft += w.ft;
      bucket.shots += w.shots;
      byWeek.set(w.weekStart, bucket);
    }
  }
  return { weeks: [...byWeek.values()].sort((a, b) => a.weekStart - b.weekStart), placedFt };
}

/* ------------------------------------------------------------------ */
/* work stoppages — the "why was this week quiet" context              */
/* ------------------------------------------------------------------ */

const STOPPAGE_TITLE_RE = /stoppage|shut\s*down|delay\s*log/i;
/** "Date" plus the variants real stoppage logs type — "Date of Stoppage",
 *  "Stop Date", "Stoppage Date", "Date Stopped". Deliberately NOT broadened
 *  to any date column: "Date Complete" is production vocabulary and must
 *  never turn a production tab into a stoppage log. */
const STOPPAGE_DATE_RE = /^date$|date\s+of\s+stop|stop(page)?\s*date|date\s+stopped/i;
const STOPPAGE_DESC_RE = /description|reason|cause|notes/i;

/** Title-only prefilter so pages can avoid decoding blobs of unrelated tabs;
 *  the full detection (headers too) is `detectStoppageTab`. */
export function isStoppageTabTitle(title: string): boolean {
  return STOPPAGE_TITLE_RE.test(title);
}

/** A Work Stoppages tab: titled like one AND carrying Date + Description
 *  headers (title alone would match a permit tab named "Stoppages Pending"
 *  that logs nothing dated). Null when the sheet has no such tab. */
export function detectStoppageTab(tabs: { title: string; data: SnapshotData }[]): {
  title: string;
  data: SnapshotData;
} | null {
  for (const t of tabs) {
    if (!STOPPAGE_TITLE_RE.test(t.title)) continue;
    const hasDate = t.data.headers.some((h) => STOPPAGE_DATE_RE.test(norm(h)));
    const hasDesc = t.data.headers.some((h) => STOPPAGE_DESC_RE.test(norm(h)));
    if (hasDate && hasDesc) return t;
  }
  return null;
}

export interface StoppageWeek {
  /** Monday of the week the stoppage falls in (local calendar), epoch ms */
  weekStart: number;
  count: number;
  /** one example reason — enough to jog a superintendent's memory */
  exemplar: string;
  /** newest ACTUAL entry date in this bucket, epoch ms — the quiet-log clock
   *  runs on entry dates, not Monday keys (a log kept Friday is 4 days newer
   *  than its bucket; bucket math overstated "days behind" by up to 6) */
  newestEntryMs: number;
}

/** Bucket the stoppage log's dated rows into the SAME Monday buckets
 *  weeklyProduction uses, so the report can sit "N stoppages (reason)"
 *  beside the week's footage. Undated/unreadable rows are skipped — the
 *  quiet-log guard (below) is what surfaces a log nobody maintains. */
export function stoppageWeeks(data: SnapshotData): Map<number, StoppageWeek> {
  let dateCol: number | null = null;
  let descCol: number | null = null;
  for (let i = 0; i < data.headers.length; i++) {
    const h = norm(data.headers[i]);
    if (dateCol === null && STOPPAGE_DATE_RE.test(h)) dateCol = i;
    if (descCol === null && STOPPAGE_DESC_RE.test(h)) descCol = i;
  }
  const byWeek = new Map<number, StoppageWeek>();
  if (dateCol === null || descCol === null) return byWeek;
  for (const r of data.rows) {
    const d = parseCompletedDate(r[dateCol]);
    if (d === null) continue; // undated/unreadable — not bucketable
    const desc = norm(r[descCol]);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (day.getDay() + 6) % 7; // Monday = 0 — same math as weeklyProduction
    const monday = day.getTime() - dow * 86_400_000;
    const bucket = byWeek.get(monday) ?? { weekStart: monday, count: 0, exemplar: desc, newestEntryMs: d.getTime() };
    bucket.count += 1;
    if (d.getTime() > bucket.newestEntryMs) bucket.newestEntryMs = d.getTime();
    if (desc !== "" && bucket.exemplar === "") bucket.exemplar = desc;
    byWeek.set(monday, bucket);
  }
  return byWeek;
}

export interface QuietStoppageLog {
  /** days the stoppage log trails the newest completed work */
  daysBehind: number;
  newestStoppage: string;
  newestCompletion: string;
}

/** Quiet-log guard: crews stop logging stoppages before they stop having
 *  them. When the newest dated stoppage trails the newest Date Complete
 *  (across the production tabs) by more than `toleranceDays` (default two
 *  weeks), the report asks the question out loud instead of implying a
 *  stoppage-free stretch. Null = nothing to judge (no log, no dated work, or
 *  the log is current). */
export function quietStoppageLog(
  stoppages: Map<number, StoppageWeek>,
  productionTabs: SnapshotData[],
  toleranceDays = 14,
): QuietStoppageLog | null {
  if (stoppages.size === 0) return null;
  // the log's clock: the newest ACTUAL entry date, never the newest Monday
  // bucket — a log kept Friday is days newer than its bucket key, and bucket
  // math overstated the trail by up to 6 days
  const newestStoppageMs = Math.max(...[...stoppages.values()].map((w) => w.newestEntryMs));
  let newestCompletionMs = 0;
  let newestCompletionRaw = "";
  for (const data of productionTabs) {
    const dateCol = detectDateColumn(data);
    if (dateCol === null) continue;
    for (const r of data.rows) {
      const d = parseCompletedDate(r[dateCol]);
      if (d === null) continue;
      if (d.getTime() > newestCompletionMs) {
        newestCompletionMs = d.getTime();
        newestCompletionRaw = norm(r[dateCol]);
      }
    }
  }
  if (newestCompletionMs === 0) return null;
  const daysBehind = Math.floor((newestCompletionMs - newestStoppageMs) / 86_400_000);
  if (daysBehind <= toleranceDays) return null;
  return {
    daysBehind,
    newestStoppage: localDayKey(new Date(newestStoppageMs)),
    newestCompletion: newestCompletionRaw,
  };
}

/* ------------------------------------------------------------------ */
/* invoice ledger — what's billable, what's billed, what's stuck       */
/* ------------------------------------------------------------------ */

const INVOICE_NUM_RE = /invoice\s*#|invoice\s*no|inv\s*#/i;
const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
const GIS_COL_RE = /bore\s*log.*gis|in\s*gis/i;
/** invoice numbers: 3–8 digits in the entered column (a bare "1"/"2" there is
 *  too ambiguous to file as an invoice number), 1–8 in the Invoice # column
 *  itself — that column exists to carry invoice numbers, so a 2-digit office
 *  numbering must land in the billed ledger, not silently vanish */
const INVOICE_DIGITS_RE = /^\d{3,8}$/;
const INVOICE_COL_DIGITS_RE = /^\d{1,8}$/;
const MONTH_PREFIX_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
/** Values in a GIS column that explicitly say the sub's log is NOT in yet.
 *  Anything else non-blank counts as in-GIS (kept permissive — date stamps,
 *  initials, "y", file names all mean done); blank still blocks because the
 *  check hasn't been done and absence of a check can't wave work through. */
const GIS_NEGATIVE_RE = /^(no|n\/?a|not yet|pending)$/i;

/** Has the run named by a month marker ("July", "January"…) already happened?
 *  Month markers carry no year, so assume the marker names the most recent
 *  occurrence of that month: the marker's upcoming run — the CURRENT month, or
 *  next month pre-queued early ("January" typed in December is next year's
 *  run, not a forgotten one) — is still queued; 1–10 months back the run has
 *  passed and the rows are a missed run to chase. Comparing bare month INDICES
 *  got exactly the December/January boundaries wrong both ways. */
function monthRunPassed(monthIdx: number, now: number): boolean {
  const monthsAgo = (new Date(now).getMonth() - monthIdx + 12) % 12;
  return monthsAgo >= 1 && monthsAgo <= 10;
}

export interface InvoiceRow {
  row: number;
  activity: string;
  completedOn: string;
  daysSinceCompletion: number;
  ft: number;
}

export interface InvoiceStatus {
  /** column headers the rollup keyed on — null pair means the tab doesn't
   *  track an office ledger and the whole feature no-ops silently */
  enteredColumn: string | null;
  invoiceColumn: string | null;
  /** completed, in GIS, never entered downstream — the A/R backlog */
  billableNow: InvoiceRow[];
  billableFt: number;
  medianAgeDays: number | null;
  oldestAgeDays: number | null;
  /** invoice numbers seen with row counts (the billed ledger) */
  billedByInvoice: { invoice: string; rows: number }[];
  /** month-named markers for a run that has already happened */
  missedRun: { invoice: string; rows: number }[];
  /** keyed downstream but matching no bucket we recognize (odd vocabulary,
   *  stray text in a ledger column) — shown, never silently dropped */
  unclassified: { row: number; value: string; column: string }[];
  unclassifiedCount: number;
}

/** Read the office's own billing ledger: "Entered in InEight" (dates once
 *  keyed, invoice numbers, or month names for a queued run) plus "Invoice #".
 *  The A/R backlog — completed, GIS-checked, never entered — ages by Date
 *  Complete because that's the clock the office actually owes on. */
export function invoiceStatus(data: SnapshotData, now = Date.now()): InvoiceStatus {
  const out: InvoiceStatus = {
    enteredColumn: null,
    invoiceColumn: null,
    billableNow: [],
    billableFt: 0,
    medianAgeDays: null,
    oldestAgeDays: null,
    billedByInvoice: [],
    missedRun: [],
    unclassified: [],
    unclassifiedCount: 0,
  };
  let enteredCol: number | null = null;
  for (let i = 0; i < data.headers.length; i++) {
    if (OFFICE_ENTERED_RE.test(norm(data.headers[i]))) {
      enteredCol = i;
      out.enteredColumn = norm(data.headers[i]);
      break;
    }
  }
  let invCol = -1;
  for (let i = 0; i < data.headers.length; i++) {
    if (INVOICE_NUM_RE.test(norm(data.headers[i]))) {
      invCol = i;
      out.invoiceColumn = norm(data.headers[i]);
      break;
    }
  }
  if (enteredCol === null) return out;
  const dateCol = detectDateColumn(data);
  if (dateCol === null) return out;
  const activityCol = detectActivityColumn(data);
  const stations = detectStationColumns(data);
  let gisCol: number | null = null;
  for (let i = 0; i < data.headers.length; i++) {
    if (GIS_COL_RE.test(norm(data.headers[i]))) {
      gisCol = i;
      break;
    }
  }

  const invCounts = new Map<string, number>();
  const missed = new Map<string, number>();
  data.rows.forEach((r, i) => {
    const entered = norm(r[enteredCol!]);
    const invoice = invCol >= 0 ? norm(r[invCol]) : "";
    if (!isFootageChainRow(r, activityCol) || isGapRow(r, activityCol)) return;
    const d = parseCompletedDate(r[dateCol]);
    if (d === null) return;
    const days = Math.floor((now - d.getTime()) / 86_400_000);
    // keyed downstream when EITHER ledger column carries a marker — an Invoice
    // # with the entered column still blank is definitionally billed and must
    // never fall through to billable-now
    if (entered !== "" || invoice !== "") {
      const marker = MONTH_RE.test(entered) ? entered : MONTH_RE.test(invoice) ? invoice : "";
      if (marker !== "") {
        const m = MONTH_PREFIX_RE.exec(marker);
        if (m) {
          const monthIdx = MONTHS.indexOf(m[1]!.toLowerCase());
          if (monthRunPassed(monthIdx, now)) missed.set(marker, (missed.get(marker) ?? 0) + 1);
          else invCounts.set(`queued: ${marker}`, (invCounts.get(`queued: ${marker}`) ?? 0) + 1);
        }
      } else {
        const numeric = INVOICE_DIGITS_RE.test(entered) ? entered : INVOICE_COL_DIGITS_RE.test(invoice) ? invoice : "";
        if (numeric !== "") {
          invCounts.set(numeric, (invCounts.get(numeric) ?? 0) + 1);
        } else {
          // keyed downstream, but the marker matches no bucket we know —
          // SURFACE it (capped) instead of letting it vanish from the ledger
          const enteredRecognized = MONTH_RE.test(entered) || INVOICE_DIGITS_RE.test(entered);
          const from = enteredRecognized ? invoice : entered !== "" ? entered : invoice;
          if (out.unclassified.length < 20) {
            out.unclassified.push({
              row: i + 1,
              value: from,
              column: entered !== "" ? (out.enteredColumn ?? "") : (out.invoiceColumn ?? ""),
            });
          }
          out.unclassifiedCount++;
        }
      }
      return;
    }
    // not entered: billable NOW when the sub's log is in GIS (or no GIS column
    // exists at all — absence of the check can't block billing; an explicit
    // "no"/"n/a" DOES block)
    if (gisCol !== null) {
      const gisVal = norm(r[gisCol]);
      if (gisVal === "" || GIS_NEGATIVE_RE.test(gisVal)) return;
    }
    // stations that don't parse are not billable footage: a null-coerced 0
    // start would inflate billableFt by the whole end station (guarded the
    // same way weeklyProduction guards its chain)
    let ft = 0;
    if (stations) {
      const s = parseStation(r[stations.start]);
      const e = parseStation(r[stations.end]);
      if (s === null || e === null) return;
      ft = Math.max(e - s, 0);
    }
    out.billableNow.push({
      row: i + 1,
      activity: activityCol !== null ? norm(r[activityCol]) : "",
      completedOn: norm(r[dateCol]),
      daysSinceCompletion: days,
      ft,
    });
  });
  out.billableNow.sort((a, b) => b.daysSinceCompletion - a.daysSinceCompletion);
  out.billableFt = out.billableNow.reduce((n, x) => n + x.ft, 0);
  if (out.billableNow.length > 0) {
    const ages = out.billableNow.map((x) => x.daysSinceCompletion);
    out.medianAgeDays = ages[Math.floor(ages.length / 2)] ?? null;
    out.oldestAgeDays = ages[0] ?? null;
  }
  out.billedByInvoice = [...invCounts.entries()]
    .map(([invoice, rows]) => ({ invoice, rows }))
    .sort((a, b) => b.rows - a.rows);
  out.missedRun = [...missed.entries()].map(([invoice, rows]) => ({ invoice, rows }));
  return out;
}

export { dedupeTabData, type DedupedTabs } from "./dedupe";

/** Sheet-wide "billable now" count on DEDUPED latest data — the number the
 *  billing dashboard shows, so the sheet-page badge and the money page can
 *  never disagree (a copy tab must not promise two invoices for one shot). */
export function sheetBillableNow(
  tabs: { title: string; data: SnapshotData; keyColumn?: number | null }[],
  now = Date.now(),
): number {
  const { freshByTab, pureCopies } = dedupeTabData(tabs);
  let count = 0;
  for (const t of tabs) {
    if (pureCopies.has(t.title)) continue;
    count += invoiceStatus({ headers: t.data.headers, rows: freshByTab.get(t.title) ?? [] }, now).billableNow.length;
  }
  return count;
}
