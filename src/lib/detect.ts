import type { SnapshotData } from "./diff/engine";
import { norm } from "./diff/normalize";

/**
 * Column detection shared by the diff engine and the checks — built around
 * real production-tracker vocabulary ("Activity", "Start STA", "End STA").
 */

const START_HEADER_RE = /(start|begin|from|beg).*?(sta|station|ft|foot|footage)/i;
const END_HEADER_RE = /(end|stop|to|finish).*?(sta|station|ft|foot|footage)/i;
const STATION_HEADER_RE = /(sta|station)/i;
export const ACTIVITY_HEADER_RE = /^(activity|type|method|work type|description)$/i;
const ADDER_ACTIVITY_RE = /adder/i;
const GAP_ACTIVITY_RE = /^gap$/i;

/** Parse a station value to feet ("15743", "4+47", "15,743"). */
export function parseStation(value: unknown): number | null {
  const t = norm(value).replace(/,/g, "").trim();
  if (t === "") return null;
  const survey = /^(\d{1,4})\+(\d{1,2})(?:\.(\d+))?$/.exec(t);
  if (survey) {
    const frac = survey[3] ? Number(`0.${survey[3]}`) : 0;
    return Number(survey[1]) * 100 + Number(survey[2]) + frac;
  }
  const plain = /^(?:sta\.?\s*)?(\d+(?:\.\d+)?)\s*(?:ft|feet|')?$/i.exec(t);
  if (plain) return Number(plain[1]);
  return null;
}

/** Find start/end station columns; null when the sheet has none. */
export function detectStationColumns(data: SnapshotData): { start: number; end: number } | null {
  const { headers, rows } = data;
  if (headers.length === 0 || rows.length === 0) return null;

  let start: number | null = null;
  let end: number | null = null;
  headers.forEach((h, i) => {
    const t = norm(h);
    if (!t) return;
    if (start === null && START_HEADER_RE.test(t)) start = i;
    if (end === null && END_HEADER_RE.test(t)) end = i;
  });
  if (start !== null && end !== null && start !== end) return { start, end };

  const candidates: number[] = [];
  headers.forEach((h, i) => {
    if (!STATION_HEADER_RE.test(norm(h))) return;
    const parsed = rows.filter((r) => parseStation(r[i]) !== null).length;
    if (parsed >= Math.max(1, rows.length * 0.5)) candidates.push(i);
  });
  if (candidates.length >= 2) return { start: candidates[0], end: candidates[1] };
  return null;
}

/** Column whose header names the activity/type, or null. */
export function detectActivityColumn(data: SnapshotData): number | null {
  for (let i = 0; i < data.headers.length; i++) {
    if (ACTIVITY_HEADER_RE.test(norm(data.headers[i]))) return i;
  }
  return null;
}

/** True for billing overlay rows (Rock/Cobble Adder) that reuse a range. */
export function isAdderRow(row: string[], activityCol: number | null): boolean {
  return activityCol !== null && ADDER_ACTIVITY_RE.test(norm(row[activityCol]));
}

/** True for explicit placeholder rows the crew books as known gaps. */
export function isGapRow(row: string[], activityCol: number | null): boolean {
  return activityCol !== null && GAP_ACTIVITY_RE.test(norm(row[activityCol]));
}

/** True for structure rows (handholes) — they sit ON a station, not footage. */
export function isHandholeRow(row: string[], activityCol: number | null): boolean {
  return activityCol !== null && /handhole|\bhh\b/i.test(norm(row[activityCol]));
}

/** True for rows that make up the footage chain: bore/plow/trench/gap, never adders. */
export function isFootageChainRow(row: string[], activityCol: number | null): boolean {
  if (activityCol === null) return true; // no activity vocabulary — don't guess
  const a = norm(row[activityCol]);
  if (a === "") return false;
  return /(bore|plow|trench|gap)/i.test(a) && !/adder/i.test(a);
}
