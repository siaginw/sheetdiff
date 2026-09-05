import { detectActivityColumn, detectStationColumns, parseStation } from "./detect";
import type { SnapshotData } from "./diff/engine";
import { detectKeyColumn, isDateishHeader } from "./diff/engine";
import { norm, normalizeKey } from "./diff/normalize";

/**
 * Cross-tab dedup — the ONE algorithm every sheet-wide rollup uses (billing
 * page, billing CSV, weekly report, billable-now badge, digest). Real
 * trackers carry compilation tabs (Line List) that re-list the working tabs'
 * shots, sometimes REFORMATTED: survey notation "2+14" for "214", different
 * column counts, retyped crews. Counting the same shot once therefore keys
 * rows by WORK IDENTITY — activity + PARSED stations — not by cell text, and
 * falls back to whole-row content only when a row has no parseable stations.
 *
 * Identity is decided once, on the LATEST data (first tab in sheet-position
 * order wins), and the same ownership is then applied to BASELINE and window
 * snapshots via `ownedRows()` — if the latest walk says tab A owns shot X,
 * X is counted in tab A at every time slice, never half in A and half in the
 * compilation tab that copied it (that mismatch produced "-25,000 ft placed
 * since collection" on sheets with a copy tab).
 *
 * All outputs are POSITION-PRESERVING: a dropped row becomes a blank row of
 * the same width, so "Row N" in every panel is the sheet's true row number
 * and column detection sees the same row count as the raw snapshot. Blank
 * rows are invisible to the footage chain, the office pipeline, and the
 * invoice ledger by construction.
 */

/** control bytes never appear in a key part — they are the separators */
const CTRL = /[\u0000-\u0008]/g;

export interface DedupTabInput {
  title: string;
  data: SnapshotData;
  /** the sheet owner's chosen key column for this tab, or null to smart-detect */
  keyColumn?: number | null;
}

const detectCache = new WeakMap<
  SnapshotData,
  { stations: { start: number; end: number } | null; activity: number | null }
>();
function columnsOf(data: SnapshotData) {
  let c = detectCache.get(data);
  if (!c) {
    c = {
      stations: detectStationColumns(data),
      activity: detectActivityColumn(data),
    };
    detectCache.set(data, c);
  }
  return c;
}

/**
 * Row identity — the SMART IDENTIFIER hierarchy, in priority order:
 *
 *   1. the tab's explicitly configured key column (owner's choice)
 *   2. work identity: activity + PARSED stations (survey/comma/plain all
 *      normalize to the same number) — the construction-sheet composite
 *   3. the auto-detected key column — an ID/SKU/ticket/name-like column that
 *      is populated and unique (only reached when the row has no stations)
 *   4. the whole row's normalized content
 *
 * This is what makes cross-tab dedup work on ANY sheet: an inventory sheet
 * keyed by SKU, a pipeline keyed by "Company", a log keyed by "Ticket #"
 * all get copy-tab detection for free, with zero configuration. Blank
 * padding -> "" (no key).
 */
/**
 * Validate an explicitly chosen key column the same way auto-detection
 * validates its own: a real identifier is populated on ~every row and UNIQUE.
 * An invalid choice (someone picked "Activity", values repeat) degrades to
 * the next identity tier instead of colliding unrelated rows — this is what
 * makes "set an identifier" safe to get wrong.
 */
const overrideCache = new WeakMap<SnapshotData, Map<number, boolean>>();
export function effectiveKeyColumn(data: SnapshotData, override?: number | null): number | null {
  if (override == null) return null;
  let m = overrideCache.get(data);
  if (!m) {
    m = new Map();
    overrideCache.set(data, m);
  }
  const hit = m.get(override);
  if (hit !== undefined) return hit ? override : null;
  const values = data.rows.map((r) => normalizeKey(r[override]));
  const nonEmpty = values.filter((v) => v !== "");
  const ok =
    nonEmpty.length > 0 && nonEmpty.length >= data.rows.length * 0.9 && new Set(nonEmpty).size === nonEmpty.length;
  m.set(override, ok);
  return ok ? override : null;
}

/**
 * Row identity — the SMART IDENTIFIER hierarchy, in priority order:
 *
 *   1. the tab's explicitly configured key column (owner's choice, validated)
 *   2. work identity: activity + PARSED stations (survey/comma/plain all
 *      normalize to the same number) — the construction-sheet composite
 *   3. the auto-detected key column — an ID/SKU/ticket/name-like column that
 *      is populated and unique (only reached when the row has no stations)
 *   4. the whole row's normalized content
 *
 * BOTH identity columns (tiers 1 and 3) must be resolved by the caller on
 * the LATEST data and passed in — never re-detected on the slice being
 * keyed. Uniqueness is data-dependent, so a baseline can detect a different
 * column than the latest, and the same physical row would then key
 * differently at different times (a copy tab's baseline escapes ownership
 * and placed-since goes wrong — the exact bug class this signature kills).
 * Blank padding -> "" (no key).
 */
export function dedupeRowKey(
  data: SnapshotData,
  row: string[],
  keyColumnOverride?: number | null,
  autoKeyColumn?: number | null,
): string {
  const { stations, activity } = columnsOf(data);
  const content = () => row.map((c) => normalizeKey(c).replace(CTRL, "")).join("\u0001");
  if (keyColumnOverride != null && keyColumnOverride >= 0) {
    const v = normalizeKey(row[keyColumnOverride]).replace(CTRL, "");
    if (v !== "") return `k${v}`;
  }
  if (stations) {
    const s = parseStation(row[stations.start]);
    const e = parseStation(row[stations.end]);
    if (s !== null && e !== null) {
      const act = activity !== null ? normalizeKey(row[activity]).replace(CTRL, "") : "";
      return `i${act}\u0001${s}\u0001${e}`;
    }
  }
  if (autoKeyColumn != null && autoKeyColumn >= 0) {
    const v = normalizeKey(row[autoKeyColumn]).replace(CTRL, "");
    if (v !== "") return `k${v}`;
  }
  const c = content();
  return c.replace(/^\u0001+$/, "") === "" ? "" : `c${c}`;
}

/** The row's content identity — ALWAYS computed, whatever tier the primary
 *  identity resolved to. Registering both lets a verbatim copy match even
 *  when the two tabs resolved DIFFERENT tiers (the working tab's key values
 *  repeat — two warehouse lines, one SKU — so it keys by content while the
 *  compilation copy, unique keys, keys by column). */
function rowContentKey(row: string[]): string {
  const c = row.map((x) => normalizeKey(x).replace(CTRL, "")).join("\u0001");
  return c.replace(/^\u0001+$/, "") === "" ? "" : `c${c}`;
}

const blank = (width: number): string[] => new Array(Math.max(width, 1)).fill("");

export interface DedupedTabs {
  /** tab title -> position-preserving rows; rows owned by an earlier tab are
   *  blanked in place (never removed, so row numbers stay true) */
  freshByTab: Map<string, string[][]>;
  /** tabs whose every non-blank row was owned by an earlier tab — pure
   * compilation tabs. Every rollup skips these entirely, INCLUDING their
   * baseline/window snapshots and their pending (to-enter) counts: the
   * working tab's own pending already lists that work. */
  pureCopies: Set<string>;
  /** how many copied rows were dropped sheet-wide */
  duplicatesDropped: number;
  /** latest-walk ownership: row key -> owning tab title (internal) */
  ownerByKey: Map<string, string>;
  /** latest-walk order (tab titles), reused for slice filtering (internal) */
  order: string[];
  /** Filter ANY other snapshot of these tabs (a baseline, a window walk) to
   *  the rows each tab OWNS. Cross-tab precedence comes from the latest walk;
   *  keys the latest data never saw (work removed since) fall to first-wins
   *  within the given slice. Position-preserving, like freshByTab. */
  ownedRows(slice: Map<string, SnapshotData>): Map<string, string[][]>;
}

/** a tab whose keyed rows are ≥95% owned by earlier tabs is a compilation
 *  tab when it carries real volume — the real Line List matches its PE tabs
 *  98% (blank-start continuation rows and station-less handhole rows never
 *  key-match), and requiring a 100% subset left it counted, doubling every
 *  number. The coverage branch is capped: a tab that owns more than ~2% of
 *  its keyed rows has real work of its own and can never be skipped — a
 *  20-copies-plus-straggler tab must not vanish. Below 20 keyed rows an
 *  EXACT subset (owned === 0) is required — small tabs must not disappear
 *  on a coincidental overlap. */
const COPY_COVERAGE = 0.95;
const COPY_MAX_STRAY = 0.02;
const COPY_MIN_KEYED = 20;

export function dedupeTabData(tabs: DedupTabInput[]): DedupedTabs {
  const ownerByKey = new Map<string, string>();
  const freshByTab = new Map<string, string[][]>();
  const pureCopies = new Set<string>();
  let duplicatesDropped = 0;
  // OWNERSHIP ORDER: richest tab first (column count desc), then sheet
  // position. Real compilation tabs RE-LIST with FEWER columns (the Frost
  // Line List carries 20 vs the PE tabs' 23) — with raw position order, a
  // compilation that precedes the tabs it copies OWNS everything and the
  // working tabs get classified as ITS copies, flipping the whole billing
  // basis (measured: 208,961 ft placed-since vs the true 0 for that window).
  // Same-width sheets fall through to position — identical to the old
  // behavior everywhere the old behavior was right.
  //
  // Known trade-off: a hypothetical compilation that ADDS columns and
  // FOLLOWS its sources can steal ownership the other way (the wider tab
  // wins). Real compilations drop columns; a tab with >2% unique rows
  // survives any misclassification with exactly its uniques intact.
  const ownershipOrder = [...tabs].sort(
    (a, b) => b.data.headers.length - a.data.headers.length || tabs.indexOf(a) - tabs.indexOf(b),
  );
  // BOTH identity columns are resolved on the LATEST data, once, and reused
  // for every slice — an override that fails validation degrades to the next
  // tier instead of colliding unrelated rows, and the auto-detected column
  // is never re-detected on a baseline (uniqueness is data-dependent; a
  // per-slice detection keys the same row differently over time and copy
  // baselines escape ownership)
  const resolvedCols = new Map<string, { override: number | null; auto: number | null; headers: string[] }>();
  for (const t of tabs) {
    const override = effectiveKeyColumn(t.data, t.keyColumn ?? null);
    // the auto tier never lands on a date/week column: a date identifies a
    // DAY, and two working tabs spanning the same period (two crew logs)
    // would otherwise collapse into one. A date key chosen EXPLICITLY is
    // honored — the owner said so
    const detected = override === null ? detectKeyColumn(t.data) : null;
    const auto = detected !== null && !isDateishHeader(t.data.headers[detected] ?? "") ? detected : null;
    resolvedCols.set(t.title, { override, auto, headers: t.data.headers });
  }
  for (const t of ownershipOrder) {
    const out: string[][] = [];
    let hadContent = false;
    let owned = 0;
    let keyed = 0;
    const { override, auto } = resolvedCols.get(t.title)!;
    // key-namespace identities (k…) dedup ACROSS tabs only: the same key
    // twice within one tab can be two legitimate rows (two warehouse rows
    // for one SKU), so they both stay — unlike station work identity (i…),
    // where the same activity+range twice in one tab is one shot listed twice
    const seenInTab = new Set<string>();
    for (const r of t.data.rows) {
      const k = dedupeRowKey(t.data, r, override, auto);
      const c = rowContentKey(r);
      if (k === "" && c === "") {
        out.push(r); // blank padding — no identity, keeps its position
        continue;
      }
      hadContent = true;
      keyed++;
      const dupInTab = k !== "" && k[0] === "k" && seenInTab.has(k);
      seenInTab.add(k);
      // dual identity: a row owned by an earlier tab under EITHER its tier
      // key or its content key is a copy — the tier can differ between the
      // working tab (key values repeat -> content tier) and its compilation
      // copy (unique keys -> column tier), and verbatim copies must match
      // whichever way each side resolved. Within ONE tab: key-namespace
      // repeats are second rows (kept), every other namespace's repeat is
      // the same work listed twice (dropped).
      const owner = k !== "" ? ownerByKey.get(k) : undefined;
      const contentOwner = c !== "" ? ownerByKey.get(c) : undefined;
      const effectiveOwner = owner ?? contentOwner;
      if (!dupInTab && effectiveOwner !== undefined && (effectiveOwner !== t.title || k[0] !== "k")) {
        duplicatesDropped++;
        out.push(blank(r.length));
        continue;
      }
      if (k !== "" && !ownerByKey.has(k)) ownerByKey.set(k, t.title);
      if (c !== "" && !ownerByKey.has(c)) ownerByKey.set(c, t.title);
      out.push(r);
      owned++;
    }
    freshByTab.set(t.title, out);
    if (hadContent && keyed > 0) {
      const coverage = (keyed - owned) / keyed;
      const strayShare = owned / keyed;
      if (owned === 0 || (keyed >= COPY_MIN_KEYED && coverage >= COPY_COVERAGE && strayShare <= COPY_MAX_STRAY)) {
        pureCopies.add(t.title);
      }
    }
  }
  const order = ownershipOrder.map((t) => t.title);
  const ownedRows = (slice: Map<string, SnapshotData>): Map<string, string[][]> => {
    const result = new Map<string, string[][]>();
    const seenInSlice = new Set<string>();
    for (const title of order) {
      const data = slice.get(title);
      if (!data) continue;
      const out: string[][] = [];
      const { override, auto, headers: latestHeaders } = resolvedCols.get(title)!;
      // header-drift guard: column indices are meaningless without the
      // layout they were resolved on. When the slice's header at the index
      // doesn't match the latest walk's, the column is a DIFFERENT column —
      // drop to the content tier rather than key by the wrong values
      const aligned = (idx: number | null): number | null =>
        idx !== null && norm(latestHeaders[idx] ?? "") === norm(data.headers[idx] ?? "") ? idx : null;
      const seenHere = new Set<string>();
      for (const r of data.rows) {
        const k = dedupeRowKey(data, r, aligned(override), aligned(auto));
        const c = rowContentKey(r);
        if (k === "" && c === "") {
          out.push(r);
          continue;
        }
        // dual identity, same rule as the latest walk (cross-tier copies)
        const owner = k !== "" ? ownerByKey.get(k) : undefined;
        const contentOwner = c !== "" ? ownerByKey.get(c) : undefined;
        const effectiveOwner = owner ?? contentOwner;
        if (effectiveOwner === undefined) {
          // work the latest walk never saw (removed since) — first tab in
          // this slice carries it so a removal nets out per tab; a
          // key-namespace repeat WITHIN that tab is a second row, kept
          const repeatInThisTab = k !== "" && k[0] === "k" && seenHere.has(k);
          if (seenInSlice.has(k) && !repeatInThisTab) {
            out.push(blank(r.length));
            continue;
          }
          if (k !== "") {
            seenInSlice.add(k);
            seenHere.add(k);
          }
          if (c !== "") seenInSlice.add(c);
          out.push(r);
          continue;
        }
        if (effectiveOwner === title) {
          if (k !== "") {
            seenInSlice.add(k); // same rule as the latest walk for consistency
            seenHere.add(k);
          }
          if (c !== "") seenInSlice.add(c);
          out.push(r); // key-namespace: the tab keeps EVERY row it owns
        } else {
          out.push(blank(r.length));
        }
      }
      result.set(title, out);
    }
    return result;
  };
  return { freshByTab, pureCopies, duplicatesDropped, ownerByKey, order, ownedRows };
}
