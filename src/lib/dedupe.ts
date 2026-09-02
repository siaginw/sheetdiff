import type { SnapshotData } from "./diff/engine";
import { detectKeyColumn } from "./diff/engine";
import { normalizeKey } from "./diff/normalize";
import { detectActivityColumn, detectStationColumns, parseStation } from "./detect";

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
  { stations: { start: number; end: number } | null; activity: number | null; keyCol: number | null }
>();
function columnsOf(data: SnapshotData) {
  let c = detectCache.get(data);
  if (!c) {
    c = {
      stations: detectStationColumns(data),
      activity: detectActivityColumn(data),
      // auto-detected identity column (ID/SKU/ticket/name...): only consulted
      // when the row has no station identity — station sheets keep their
      // proven activity+stations composite as the identity
      keyCol: detectKeyColumn(data),
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
    nonEmpty.length > 0 &&
    nonEmpty.length >= data.rows.length * 0.9 &&
    new Set(nonEmpty).size === nonEmpty.length;
  m.set(override, ok);
  return ok ? override : null;
}

export function dedupeRowKey(data: SnapshotData, row: string[], keyColumnOverride?: number | null): string {
  const { stations, activity, keyCol } = columnsOf(data);
  const content = () =>
    row.map((c) => normalizeKey(c).replace(CTRL, "")).join("\u0001");
  // the override must be a RESOLVED column (run through effectiveKeyColumn on
  // the LATEST data) — validity is decided once per sheet, never per slice,
  // or the same row would key differently at different times
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
  if (keyCol !== null) {
    const v = normalizeKey(row[keyCol]).replace(CTRL, "");
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
 *  number. Below 20 keyed rows an EXACT subset is required — small tabs
 *  must not disappear on a coincidental overlap. */
const COPY_COVERAGE = 0.95;
const COPY_MIN_KEYED = 20;

export function dedupeTabData(tabs: DedupTabInput[]): DedupedTabs {
  const ownerByKey = new Map<string, string>();
  const freshByTab = new Map<string, string[][]>();
  const pureCopies = new Set<string>();
  let duplicatesDropped = 0;
  const resolvedKeyCol = new Map<string, number | null>();
  for (const t of tabs) {
    const out: string[][] = [];
    let hadContent = false;
    let owned = 0;
    let keyed = 0;
    // the identity tier is decided HERE, on the latest data, once — an
    // invalid override (values repeat, so the column can't identify rows)
    // degrades to the next tier instead of colliding unrelated rows
    const effCol = effectiveKeyColumn(t.data, t.keyColumn ?? null);
    resolvedKeyCol.set(t.title, effCol);
    // key-namespace identities (k…) dedup ACROSS tabs only: the same key
    // twice within one tab can be two legitimate rows (two warehouse rows
    // for one SKU), so they both stay — unlike station work identity (i…),
    // where the same activity+range twice in one tab is one shot listed twice
    const seenInTab = new Set<string>();
    for (const r of t.data.rows) {
      const k = dedupeRowKey(t.data, r, effCol);
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
      const owner = ownerByKey.get(k) ?? ownerByKey.get(c);
      if (!dupInTab && owner !== undefined && (owner !== t.title || k[0] !== "k")) {
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
      if (owned === 0 || (keyed >= COPY_MIN_KEYED && coverage >= COPY_COVERAGE)) {
        pureCopies.add(t.title);
      }
    }
  }
  const tabByTitle = new Map(tabs.map((t) => [t.title, t] as const));
  const order = tabs.map((t) => t.title);
  const ownedRows = (slice: Map<string, SnapshotData>): Map<string, string[][]> => {
    const result = new Map<string, string[][]>();
    const seenInSlice = new Set<string>();
    for (const title of order) {
      const data = slice.get(title);
      if (!data) continue;
      const out: string[][] = [];
      const keyCol = resolvedKeyCol.get(title) ?? null;
      const seenHere = new Set<string>();
      for (const r of data.rows) {
        const k = dedupeRowKey(data, r, keyCol);
        const c = rowContentKey(r);
        if (k === "" && c === "") {
          out.push(r);
          continue;
        }
        // dual identity, same rule as the latest walk (cross-tier copies)
        const owner = ownerByKey.get(k) ?? ownerByKey.get(c);
        if (owner === undefined) {
          // work the latest walk never saw (removed since) — first tab in
          // this slice carries it, so a removal still nets out per tab;
          // key-namespace repeats within one tab are second rows, kept
          if (seenInSlice.has(k) && !(k !== "" && k[0] === "k" && !seenHere.has(k))) {
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
        if (owner === title) {
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
