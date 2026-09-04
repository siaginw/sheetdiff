import { detectStationColumns, parseStation } from "./detect";
import type { SnapshotData } from "./diff/engine";
import { norm, normalizeKey, sameValue } from "./diff/normalize";

/**
 * Shot history: trace one row through a sequence of snapshots and report
 * every value change, newest first. Matching works three ways, no ID column
 * required:
 *  - a station NUMBER ("14800") → the row covering that station
 *  - free text ("HAIDER") → the first row containing it
 *  - a row key → exact composite/single-key match
 */

export interface TraceChange {
  header: string;
  from: string;
  to: string;
}

export interface TraceEvent {
  at: number;
  kind: "added" | "removed" | "changed";
  changes: TraceChange[];
}

export interface TraceSnap {
  createdAt: number;
  data: SnapshotData;
}

type RowMatcher = (data: SnapshotData) => string[] | null;

function makeMatcher(needleRaw: string): RowMatcher {
  const station = parseStation(needleRaw);
  if (station !== null && /^[\d.,+]+\s*(?:ft|feet)?$/i.test(needleRaw.trim())) {
    // station mode: the row whose START/END station cells cover the number —
    // never row-order numerics (a "#" index or Total Footage column would
    // otherwise decide the span)
    return (data) => {
      const st = detectStationColumns(data);
      return (
        data.rows.find((row) => {
          if (st) {
            const s0 = parseStation(row[st.start]);
            const e0 = parseStation(row[st.end]);
            return s0 !== null && e0 !== null && s0 <= station && station <= e0;
          }
          const nums = row.map((v) => parseStation(v)).filter((n) => n !== null) as number[];
          return nums.length >= 2 && Math.min(...nums) <= station && station <= Math.max(...nums);
        }) ?? null
      );
    };
  }
  const needle = needleRaw.trim().toLowerCase();
  const asKey = needle
    .split(/\s+/)
    .map((p) => normalizeKey(p))
    .join("·");
  return (data) => {
    // exact key/composite match first
    const exact = data.rows.find(
      (row) =>
        row
          .map((v) => normalizeKey(v))
          .filter((v) => v !== "")
          .join("·") === asKey && asKey !== "",
    );
    if (exact) return exact;
    // then containment: any cell contains the text
    return data.rows.find((row) => row.some((v) => v.toLowerCase().includes(needle))) ?? null;
  };
}

/**
 * @param snaps oldest → newest, GIS imports already excluded by the caller
 */
export function traceKey(snaps: TraceSnap[], key: string): TraceEvent[] {
  const match = makeMatcher(key);
  const events: TraceEvent[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = match(snaps[i - 1].data);
    const cur = match(snaps[i].data);
    const at = snaps[i].createdAt;

    if (!prev && cur) {
      events.push({
        at,
        kind: "added",
        changes: snaps[i].data.headers.map((h, c) => ({ header: norm(h), from: "", to: norm(cur[c]) })),
      });
    } else if (prev && !cur) {
      events.push({
        at,
        kind: "removed",
        changes: snaps[i - 1].data.headers.map((h, c) => ({ header: norm(h), from: norm(prev[c]), to: "" })),
      });
    } else if (prev && cur) {
      const changes: TraceChange[] = [];
      for (let c = 0; c < snaps[i].data.headers.length; c++) {
        const from = norm(prev[c]);
        const to = norm(cur[c]);
        if (!sameValue(from, to)) {
          changes.push({ header: norm(snaps[i].data.headers[c]), from, to });
        }
      }
      if (changes.length > 0) events.push({ at, kind: "changed", changes });
    }
  }
  return events.reverse(); // newest first
}
