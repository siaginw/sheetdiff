import type { SnapshotData } from "./diff/engine";
import { norm, normalizeKey, sameValue } from "./diff/normalize";

/**
 * Shot history: trace one row (matched by its key column) through a sequence
 * of snapshots and report every value change, newest first. Answers the audit
 * question "when did this shot's numbers change, and to what?" without
 * clicking through snapshot pairs.
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

/** Find the row matching `key` in a snapshot, or null. */
function findRow(data: SnapshotData, keyCol: number, key: string): string[] | null {
  for (const row of data.rows) {
    if (normalizeKey(row[keyCol]) === key) return row;
  }
  return null;
}

/**
 * @param snaps oldest → newest, GIS imports already excluded by the caller
 * @param key already normalized (use normalizeKey on user input)
 */
export function traceKey(snaps: TraceSnap[], keyCol: number, key: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = findRow(snaps[i - 1].data, keyCol, key);
    const cur = findRow(snaps[i].data, keyCol, key);
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
