import type { SnapshotData } from "./diff/engine";
import { norm } from "./diff/normalize";
import { detectStationColumns, detectActivityColumn, parseStation, isFootageChainRow, isGapRow } from "./detect";

/**
 * The auto gap report: reconstructs a tab's footage chain from ONLY the
 * bore/plow/trench/gap rows (handholes sit on stations; adders are billing),
 * sorted by station, and reconciles the math:
 *
 *   placed + known gaps + unaccounted gaps − overlaps ≈ designed span
 *
 * Unaccounted gaps — holes in the chain nobody booked — are the actionable
 * output: exact ranges the crew needs to work or gap explicitly.
 */

export interface GapSegment {
  from: number;
  to: number;
  ft: number;
  /** 1-based data row this gap follows (the row ending at `from`) */
  afterRow: number;
}

export interface GapReport {
  chainStart: number | null;
  chainEnd: number | null;
  designedSpan: number | null;
  placedFt: number;
  knownGaps: GapSegment[];
  unaccounted: GapSegment[];
  overlaps: GapSegment[];
  /** rows skipped because their stations didn't parse */
  invalid: number;
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
  };
  if (!stations) return report;
  const activityCol = detectActivityColumn(data);

  // chain members: footage activities only, with parseable forward stations
  const members = data.rows
    .map((row, i) => ({
      i,
      row,
      gap: isGapRow(row, activityCol),
      start: parseStation(row[stations.start]),
      end: parseStation(row[stations.end]),
    }))
    .filter((m) => isFootageChainRow(m.row, activityCol))
    .map((m) => {
      if (m.start === null || m.end === null || m.end < m.start) report.invalid++;
      return m;
    })
    .filter((m): m is typeof m & { start: number; end: number } =>
      m.start !== null && m.end !== null && m.end >= m.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i);

  if (members.length === 0) return report;
  report.chainStart = members[0]!.start;
  report.chainEnd = Math.max(...members.map((m) => m.end));
  report.designedSpan = report.chainEnd - report.chainStart;

  let coveredTo = members[0]!.start;
  for (const m of members) {
    if (m.gap) {
      // a booked gap occupies its span: recorded, counts as known (not placed)
      report.knownGaps.push({ from: m.start, to: m.end, ft: m.end - m.start, afterRow: m.i + 1 });
      coveredTo = Math.max(coveredTo, m.end);
      continue;
    }
    if (m.start > coveredTo) {
      report.unaccounted.push({ from: coveredTo, to: m.start, ft: m.start - coveredTo, afterRow: m.i + 1 });
    } else if (m.start < coveredTo) {
      report.overlaps.push({ from: m.start, to: Math.min(coveredTo, m.end), ft: coveredTo - m.start, afterRow: m.i + 1 });
    }
    report.placedFt += m.end - m.start;
    coveredTo = Math.max(coveredTo, m.end);
  }
  // tail after the last row is the crew's business, not ours: no trailing gap
  return report;
}

/** Human label for a station number in report lines ("14800" or "148+00"). */
export function stationLabel(n: number): string {
  return norm(String(Math.round(n)));
}
