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

import { norm, normalizeKey } from "./diff/normalize";
import type { SnapshotData } from "./diff/engine";
import { detectCompositeKey } from "./diff/engine";
import {
  parseStation,
  detectStationColumns,
  detectActivityColumn,
  isAdderRow,
  isGapRow,
} from "./detect";

// re-exported for existing callers/tests
export { parseStation, detectStationColumns, detectActivityColumn } from "./detect";

export type CheckSeverity = "error" | "warning";

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

/** Row identity per tab: explicit single key, else the auto composite. */
function keyOfClosure(data: SnapshotData, keyColumn: number | null): ((row: string[]) => string) | null {
  if (keyColumn !== null && keyColumn >= 0 && keyColumn < data.headers.length) {
    return (row) => normalizeKey(row[keyColumn]);
  }
  const composite = detectCompositeKey(data);
  if (composite) {
    return (row) =>
      composite
        .map((c) => normalizeKey(row[c]))
        .filter((v) => v !== "")
        .join("·");
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
      const { start, end } = stations;
      const activityCol = detectActivityColumn(data);
      // adders overlay real segments — not chain rows; GAP rows chain through
      // (they book the missing footage) but never flag as findings themselves
      const parsed = data.rows
        .map((r, i) => ({
          i,
          adder: isAdderRow(r, activityCol),
          start: parseStation(r[start]),
          end: parseStation(r[end]),
          startRaw: norm(r[start]),
          endRaw: norm(r[end]),
        }))
        .filter((p) => !p.adder);
      // a row running backwards is its own finding
      for (const p of parsed) {
        if (p.start !== null && p.end !== null && p.end < p.start) {
          findings.push({
            kind: "gap",
            severity: "error",
            tabTitle,
            message: `row ${p.i + 1} runs backwards: start ${p.startRaw} > end ${p.endRaw}`,
            rows: [p.i + 1],
          });
        }
      }
      for (let k = 0; k + 1 < parsed.length; k++) {
        const cur = parsed[k];
        const next = parsed[k + 1];
        if (cur.end === null || next.start === null) continue;
        const delta = next.start - cur.end;
        if (delta > 0) {
          findings.push({
            kind: "gap",
            severity: "warning",
            tabTitle,
            message: `${delta} ft gap: row ${cur.i + 1} ends at ${cur.endRaw} but row ${next.i + 1} starts at ${next.startRaw}`,
            rows: [cur.i + 1, next.i + 1],
          });
        } else if (delta < 0) {
          findings.push({
            kind: "overlap",
            severity: "error",
            tabTitle,
            message: `${Math.abs(delta)} ft overlap: row ${cur.i + 1} ends at ${cur.endRaw} but row ${next.i + 1} starts at ${next.startRaw}`,
            rows: [cur.i + 1, next.i + 1],
          });
        }
      }
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
  for (const [k, owners] of keyOwners) {
    const uniqueTabs = new Set(owners.map((o) => o.tab));
    if (uniqueTabs.size > 1) {
      findings.push({
        kind: "cross-tab",
        severity: "error",
        tabTitle: owners[0].tab,
        message: `“${k.replace(/·/g, " ")}” appears in ${[...uniqueTabs].join(" and ")} — should be in only one`,
        rows: owners.map((o) => o.row),
      });
    }
  }

  return findings;
}
