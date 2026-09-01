import type { SnapshotData } from "./diff/engine";
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

const detectCache = new WeakMap<SnapshotData, { stations: { start: number; end: number } | null; activity: number | null }>();
function columnsOf(data: SnapshotData) {
  let c = detectCache.get(data);
  if (!c) {
    c = { stations: detectStationColumns(data), activity: detectActivityColumn(data) };
    detectCache.set(data, c);
  }
  return c;
}

/** Work identity of a row on its tab: activity + parsed stations when the
 *  stations parse (survey/comma/plain all normalize to the same number), the
 *  whole row's normalized content otherwise. Blank padding -> "" (no key). */
export function dedupeRowKey(data: SnapshotData, row: string[]): string {
  const { stations, activity } = columnsOf(data);
  const content = () =>
    row.map((c) => normalizeKey(c).replace(CTRL, "")).join("\u0001");
  if (stations) {
    const s = parseStation(row[stations.start]);
    const e = parseStation(row[stations.end]);
    if (s !== null && e !== null) {
      const act = activity !== null ? normalizeKey(row[activity]).replace(CTRL, "") : "";
      return `i${act}\u0001${s}\u0001${e}`;
    }
  }
  const c = content();
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

export function dedupeTabData(tabs: { title: string; data: SnapshotData }[]): DedupedTabs {
  const ownerByKey = new Map<string, string>();
  const freshByTab = new Map<string, string[][]>();
  const pureCopies = new Set<string>();
  let duplicatesDropped = 0;
  for (const t of tabs) {
    const out: string[][] = [];
    let hadContent = false;
    let owned = 0;
    let keyed = 0;
    for (const r of t.data.rows) {
      const k = dedupeRowKey(t.data, r);
      if (k === "") {
        out.push(r); // blank padding — no identity, keeps its position
        continue;
      }
      hadContent = true;
      keyed++;
      if (ownerByKey.has(k)) {
        duplicatesDropped++;
        out.push(blank(r.length));
        continue;
      }
      ownerByKey.set(k, t.title);
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
  const order = tabs.map((t) => t.title);
  const ownedRows = (slice: Map<string, SnapshotData>): Map<string, string[][]> => {
    const result = new Map<string, string[][]>();
    const seenInSlice = new Set<string>();
    for (const title of order) {
      const data = slice.get(title);
      if (!data) continue;
      const out: string[][] = [];
      for (const r of data.rows) {
        const k = dedupeRowKey(data, r);
        if (k === "") {
          out.push(r);
          continue;
        }
        const owner = ownerByKey.get(k);
        if (owner === undefined) {
          // work the latest walk never saw (removed since) — first tab in
          // this slice carries it, so a removal still nets out per tab
          if (seenInSlice.has(k)) {
            out.push(blank(r.length));
            continue;
          }
          seenInSlice.add(k);
          out.push(r);
          continue;
        }
        if (owner === title) {
          seenInSlice.add(k); // same rule as the latest walk for consistency
          out.push(r);
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
