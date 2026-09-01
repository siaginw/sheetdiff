import type { SnapshotData } from "./diff/engine";
import { norm } from "./diff/normalize";
import { detectStationColumns, detectActivityColumn, parseStation, isFootageChainRow, isGapRow } from "./detect";

/**
 * The auto gap report: reconstructs a tab's footage chain from ONLY the
 * bore/plow/trench/gap rows (handholes sit on stations; adders are billing),
 * sorted by station, and reconciles the math:
 *
 *   placed + known gaps + unaccounted gaps − overlaps = designed span
 *
 * GAP rows participate in the unaccounted/overlap checks like any chain row —
 * a booked gap can itself sit on a hole (nobody booked the footage BEFORE it)
 * or overlap placed work — but never counts toward placed footage.
 */

export interface GapSegment {
  from: number;
  to: number;
  ft: number;
  /** 1-based data row this segment FOLLOWS (the member ending at `from`) */
  afterRow: number;
  /** true when unreadable chain rows sit between the two members — the
   *  finding may actually be a station typo in one of those rows */
  spansInvalid: boolean;
}

export interface InvalidChainRow {
  row: number;
  startRaw: string;
  endRaw: string;
}

export interface GapReport {
  chainStart: number | null;
  chainEnd: number | null;
  designedSpan: number | null;
  placedFt: number;
  knownGaps: GapSegment[];
  unaccounted: GapSegment[];
  overlaps: GapSegment[];
  /** chain rows whose stations didn't parse (count kept for the panel) */
  invalid: number;
  invalidRows: InvalidChainRow[];
}

export function computeGapReport(data: SnapshotData): GapReport {
  const stations = detectStationColumns(data);
  const report: GapReport = {
    chainStart: null,
    chainEnd: null,
    designedSpan: null,
    placedFt: 0,
    knownGaps: [],
    unaccounted: [],
    overlaps: [],
    invalid: 0,
    invalidRows: [],
  };
  if (!stations) return report;
  const activityCol = detectActivityColumn(data);

  // chain members: footage activities only, with parseable forward stations
  const invalidIdx: number[] = [];
  const members = data.rows
    .map((row, i) => ({
      i,
      row,
      gap: isGapRow(row, activityCol),
      start: parseStation(row[stations.start]),
      end: parseStation(row[stations.end]),
    }))
    .filter((m) => isFootageChainRow(m.row, activityCol))
    .filter((m) => {
      if (m.start === null || m.end === null || m.end < m.start) {
        report.invalid++;
        if (report.invalidRows.length < 10) {
          report.invalidRows.push({
            row: m.i + 1,
            startRaw: norm(m.row[stations.start]),
            endRaw: norm(m.row[stations.end]),
          });
        }
        invalidIdx.push(m.i);
        return false;
      }
      return true;
    })
    .sort((a, b) => a.start! - b.start! || a.end! - b.end! || a.i - b.i);

  if (members.length === 0) return report;
  const chainStart = members[0]!.start!;
  // loop, not Math.max(...members.map()) — the spread blows the stack around
  // ~140k rows and takes the whole gap report down with it
  let chainEnd = members[0]!.end!;
  for (const m of members) if (m.end! > chainEnd) chainEnd = m.end!;
  report.chainStart = chainStart;
  report.chainEnd = chainEnd;
  report.designedSpan = chainEnd - chainStart;

  const spansInvalidBetween = (prevIdx: number, curIdx: number) =>
    invalidIdx.some((k) => k > prevIdx && k < curIdx);

  let coveredTo = 0;
  let prev: (typeof members)[number] | null = null;
  for (const m of members) {
    const anchor = prev === null ? m.start! : coveredTo; // first member anchors the chain
    if (m.start! > anchor) {
      report.unaccounted.push({
        from: anchor,
        to: m.start!,
        ft: m.start! - anchor,
        afterRow: (prev?.i ?? m.i) + 1,
        spansInvalid: prev !== null && spansInvalidBetween(prev.i, m.i),
      });
    } else if (m.start! < anchor) {
      report.overlaps.push({
        from: m.start!,
        to: Math.min(anchor, m.end!),
        ft: Math.min(anchor, m.end!) - m.start!,
        afterRow: m.i + 1,
        spansInvalid: false,
      });
    }
    if (m.gap) {
      report.knownGaps.push({ from: m.start!, to: m.end!, ft: m.end! - m.start!, afterRow: m.i + 1, spansInvalid: false });
    } else {
      report.placedFt += m.end! - m.start!;
    }
    coveredTo = Math.max(coveredTo, m.end!);
    prev = m;
  }
  return report;
}
