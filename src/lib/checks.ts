/**
 * Sheet health checks — the "gap linter".
 *
 * Runs against the latest snapshot of each tracked tab and flags:
 *  - station-continuity breaks: consecutive rows whose end→start stations
 *    leave unaccounted footage (gaps) or overlap (double-counted footage)
 *  - duplicate row identities within a tab (e.g. the same activity+range
 *    entered twice)
 *  - the same identity appearing in multiple tabs (e.g. a shot in PE6 and PE7)
 *
 * Row identity: an explicit single key column when configured/detected, else a
 * COMPOSITE of Activity + Start STA + End STA — trackers can't always add an
 * ID column, but "the 14800–15743 plow" is already how crews identify shots.
 */

import { norm, normalizeKey, compositeKey } from "./diff/normalize";
import type { SnapshotData } from "./diff/engine";
import { detectCompositeKey } from "./diff/engine";
import { computeGapReport } from "./gaps";
import {
  parseStation,
  detectStationColumns,
  detectActivityColumn,
  isFootageChainRow,
  isAdderRow,
  isGapRow,
} from "./detect";

// re-exported for existing callers/tests
export { parseStation, detectStationColumns, detectActivityColumn } from "./detect";

export type CheckSeverity = "error" | "warning";

/** Over this many findings of one kind on one tab, collapse to a summary. */
const COLLAPSE_AT = 10;

export interface CheckFinding {
  kind: "gap" | "overlap" | "dupe-key" | "cross-tab";
  severity: CheckSeverity;
  tabTitle: string;
  message: string;
  /** 1-based data row numbers involved (for jumping to the row) */
  rows: number[];
}

export interface TabChecksInput {
  tabTitle: string;
  data: SnapshotData;
  keyColumn: number | null;
}

/**
 * Row identity per tab: an explicit single key, else the composite of
 * Activity + stations — WITHOUT detectCompositeKey's uniqueness gate: for
 * duplicate detection the repeats are the point, and gating on uniqueness
 * self-disables exactly when duplicates exist (small tabs).
 */
function keyOfClosure(data: SnapshotData, keyColumn: number | null): ((row: string[]) => string) | null {
  if (keyColumn !== null && keyColumn >= 0 && keyColumn < data.headers.length) {
    return (row) => normalizeKey(row[keyColumn]);
  }
  const stations = detectStationColumns(data);
  const activity = detectActivityColumn(data);
  if (stations && activity !== null) {
    const cols = [activity, stations.start, stations.end];
    return (row) => compositeKey(row, cols);
  }
  return null;
}

export interface FootageTotal {
  /** summed PLACED footage (end − start); adders and GAP placeholders excluded */
  ft: number;
  /** rows included in the total */
  shots: number;
  /** rows whose stations didn't parse or ran backwards */
  invalid: number;
  /** handhole/structure rows (zero-length; counted as structures, not footage) */
  handholes: number;
  /** explicit GAP placeholder rows, with their unworked span */
  gaps: { count: number; ft: number };
}

/** Sum a tab's footage using the detected station columns. */
export function computeFootage(
  data: SnapshotData,
): FootageTotal & { stations: { start: number; end: number } | null } {
  const stations = detectStationColumns(data);
  const out: FootageTotal & { stations: { start: number; end: number } | null } = {
    ft: 0,
    shots: 0,
    invalid: 0,
    handholes: 0,
    gaps: { count: 0, ft: 0 },
    stations,
  };
  if (!stations) return out;
  const activityCol = detectActivityColumn(data);
  for (const r of data.rows) {
    if (isAdderRow(r, activityCol)) continue; // billing overlay
    const s = parseStation(r[stations.start]);
    const e = parseStation(r[stations.end]);
    if (isGapRow(r, activityCol)) {
      // a booked GAP is unworked footage: counted separately, never "placed"
      if (s !== null && e !== null && e >= s) {
        out.gaps.count++;
        out.gaps.ft += e - s;
      }
      continue;
    }
    if (s === null || e === null || e < s) {
      out.invalid++;
      continue;
    }
    if (e === s) {
      out.handholes++; // structures sit at a station, contribute no footage
      continue;
    }
    out.ft += e - s;
    out.shots++;
  }
  return out;
}

/** Run all checks across the given tabs (latest snapshots). */
export function runChecks(tabs: TabChecksInput[]): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const { tabTitle, data, keyColumn } of tabs) {
    // ---- station continuity ----
    const stations = detectStationColumns(data);
    if (stations) {
      const activityCol = detectActivityColumn(data);
      // gap/overlap findings come from the SORTED chain reconstruction
      // (computeGapReport) so the checks panel and the gap report can never
      // disagree — out-of-order rows are not findings, holes and overlaps are
      const report = computeGapReport(data);
      // A tab with dozens of tiny holes/overlaps (systematically interleaved
      // or double-entered rows — the real 43-tab tracker's Line List makes
      // ~950) drowns every other signal in the checks panel AND the digest.
      // Collapse oversized lists into one honest summary; the gap report
      // panel keeps the itemized, aged view.
      if (report.unaccounted.length > COLLAPSE_AT) {
        const ft = report.unaccounted.reduce((n, g) => n + g.ft, 0);
        const first = report.unaccounted[0]!;
        findings.push({
          kind: "gap",
          severity: "warning",
          tabTitle,
          message: `${report.unaccounted.length} unaccounted holes totaling ${ft.toLocaleString()} ft (e.g. stations ${first.from.toLocaleString()}–${first.to.toLocaleString()} after row ${first.afterRow}) — see the gap report for the itemized list`,
          rows: [first.afterRow],
        });
      } else {
        for (const g of report.unaccounted) {
          findings.push({
            kind: "gap",
            severity: "warning",
            tabTitle,
            message:
              `${g.ft} ft unaccounted: stations ${g.from.toLocaleString()}–${g.to.toLocaleString()} (after row ${g.afterRow})` +
              (g.spansInvalid ? " — unreadable chain rows in between; check those stations for typos" : ""),
            rows: [g.afterRow],
          });
        }
      }
      if (report.overlaps.length > COLLAPSE_AT) {
        const ft = report.overlaps.reduce((n, o) => n + o.ft, 0);
        const first = report.overlaps[0]!;
        findings.push({
          kind: "overlap",
          severity: "error",
          tabTitle,
          message: `${report.overlaps.length} overlaps totaling ${ft.toLocaleString()} ft (e.g. stations ${first.from.toLocaleString()}–${first.to.toLocaleString()} after row ${first.afterRow}) — the chain double-counts repeatedly; check for duplicated or double-entered rows (see the gap report for the itemized list)`,
          rows: [first.afterRow],
        });
      } else {
        for (const o of report.overlaps) {
          findings.push({
            kind: "overlap",
            severity: "error",
            tabTitle,
            message: `${o.ft} ft overlap: stations ${o.from.toLocaleString()}–${o.to.toLocaleString()} double-counted (after row ${o.afterRow})`,
            rows: [o.afterRow],
          });
        }
      }
      // backwards rows are their own finding regardless of the chain
      const stations0 = stations;
      data.rows.forEach((r, i) => {
        const st = parseStation(r[stations0.start]);
        const en = parseStation(r[stations0.end]);
        if (st !== null && en !== null && en < st && isFootageChainRow(r, activityCol)) {
          findings.push({
            kind: "gap",
            severity: "error",
            tabTitle,
            message: `row ${i + 1} runs backwards: start ${norm(r[stations0.start])} > end ${norm(r[stations0.end])}`,
            rows: [i + 1],
          });
        }
      });
    }

    // ---- duplicate identities within the tab ----
    const keyOf = keyOfClosure(data, keyColumn);
    if (keyOf) {
      const seen = new Map<string, number[]>();
      data.rows.forEach((r, i) => {
        const k = keyOf(r);
        if (k === "") return;
        const list = seen.get(k) ?? [];
        list.push(i + 1);
        seen.set(k, list);
      });
      for (const [k, rowNums] of seen) {
        if (rowNums.length > 1) {
          findings.push({
            kind: "dupe-key",
            severity: "error",
            tabTitle,
            message: `“${k.replace(/·/g, " ")}” appears ${rowNums.length}× (rows ${rowNums.join(", ")}) — duplicate shot?`,
            rows: rowNums,
          });
        }
      }
    }
  }

  // ---- same identity in multiple tabs ----
  const keyOwners = new Map<string, { tab: string; row: number }[]>();
  for (const { tabTitle, data, keyColumn } of tabs) {
    const keyOf = keyOfClosure(data, keyColumn);
    if (!keyOf) continue;
    data.rows.forEach((r, i) => {
      const k = keyOf(r);
      if (k === "") return;
      const list = keyOwners.get(k) ?? [];
      list.push({ tab: tabTitle, row: i + 1 });
      keyOwners.set(k, list);
    });
  }
  type CrossEntry = { k: string; owners: { tab: string; row: number }[] };
  const crossEntries: CrossEntry[] = [];
  for (const [k, owners] of keyOwners) {
    const uniqueTabs = new Set(owners.map((o) => o.tab));
    if (uniqueTabs.size > 1) crossEntries.push({ k, owners });
  }
  // group by the tab the finding is reported under, then collapse oversized
  // groups: a compilation tab (the real tracker's Line List) shares identities
  // with EVERY working tab by design and otherwise floods the panel with
  // 1000+ findings that each name the same two tabs
  const crossByTab = new Map<string, CrossEntry[]>();
  for (const e of crossEntries) {
    const list = crossByTab.get(e.owners[0]!.tab) ?? [];
    list.push(e);
    crossByTab.set(e.owners[0]!.tab, list);
  }
  for (const [tabTitle, entries] of crossByTab) {
    if (entries.length > COLLAPSE_AT) {
      const otherTabs = new Set<string>();
      for (const e of entries) for (const o of e.owners) if (o.tab !== tabTitle) otherTabs.add(o.tab);
      findings.push({
        kind: "cross-tab",
        severity: "error",
        tabTitle,
        message: `${entries.length} identities also appear in ${[...otherTabs].length} other tab${[...otherTabs].length === 1 ? "" : "s"} (e.g. “${entries[0]!.k.replace(/·/g, " ")}”) — a compilation tab, or shots entered in two places?`,
        rows: entries[0]!.owners.map((o) => o.row),
      });
    } else {
      for (const e of entries) {
        const uniqueTabs = new Set(e.owners.map((o) => o.tab));
        findings.push({
          kind: "cross-tab",
          severity: "error",
          tabTitle: e.owners[0]!.tab,
          message: `“${e.k.replace(/·/g, " ")}” appears in ${[...uniqueTabs].join(" and ")} — should be in only one`,
          rows: e.owners.map((o) => o.row),
        });
      }
    }
  }

  return findings;
}
