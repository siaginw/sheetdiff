/**
 * Sheet health checks — the "gap linter".
 *
 * Runs against the latest snapshot of each tracked tab and flags:
 *  - station-continuity breaks: consecutive rows whose end→start stations
 *    leave unaccounted footage (gaps) or overlap (double-counted footage)
 *  - duplicate row keys within a tab (e.g. the same shot entered as Bore
 *    and Plow)
 *  - the same key appearing in multiple tabs (e.g. a shot in PE6 and PE7)
 *
 * Station formats seen in the field: plain feet ("15743") and survey
 * notation ("4+47" = 447 ft, "267+18" = 26,718 ft).
 */

import { norm, normalizeKey } from "./diff/normalize";
import type { SnapshotData } from "./diff/engine";

/** Parse a station value to feet. Returns null when not station-like. */
export function parseStation(value: unknown): number | null {
  const t = norm(value).replace(/,/g, "").trim();
  if (t === "") return null;
  // survey notation: "4+47", "164+82" (also tolerates multi-plus like "26+7+18"? no — strict)
  const survey = /^(\d{1,4})\+(\d{1,2})(?:\.(\d+))?$/.exec(t);
  if (survey) {
    const frac = survey[3] ? Number(`0.${survey[3]}`) : 0;
    return Number(survey[1]) * 100 + Number(survey[2]) + frac;
  }
  // plain feet (possibly with a unit suffix)
  const plain = /^(?:sta\.?\s*)?(\d+(?:\.\d+)?)\s*(?:ft|feet|')?$/i.exec(t);
  if (plain) return Number(plain[1]);
  return null;
}

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

const START_HEADER_RE = /(start|begin|from|beg)\b.*?(sta|station|ft|foot|footage)/i;
const END_HEADER_RE = /(end|stop|to|finish)\b.*?(sta|station|ft|foot|footage)/i;
const STATION_HEADER_RE = /(sta|station)/i;

/**
 * Find start/end station columns: prefer explicit "start station"/"end
 * station" headers, else the first two station-ish numeric columns in order.
 */
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

  // fallback: columns named like stations that mostly parse
  const candidates: number[] = [];
  headers.forEach((h, i) => {
    if (!STATION_HEADER_RE.test(norm(h))) return;
    const parsed = rows.filter((r) => parseStation(r[i]) !== null).length;
    if (parsed >= Math.max(1, rows.length * 0.5)) candidates.push(i);
  });
  if (candidates.length >= 2) return { start: candidates[0], end: candidates[1] };
  return null;
}

/** Run all checks across the given tabs (latest snapshots). */
export function runChecks(tabs: TabChecksInput[]): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const { tabTitle, data, keyColumn } of tabs) {
    // ---- station continuity ----
    const stations = detectStationColumns(data);
    if (stations) {
      const { start, end } = stations;
      const parsed = data.rows.map((r, i) => ({
        i,
        start: parseStation(r[start]),
        end: parseStation(r[end]),
        startRaw: norm(r[start]),
        endRaw: norm(r[end]),
      }));
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
            message: `${delta} ft gap: row ${k + 1} ends at ${cur.endRaw} but row ${k + 2} starts at ${next.startRaw}`,
            rows: [k + 1, k + 2],
          });
        } else if (delta < 0) {
          findings.push({
            kind: "overlap",
            severity: "error",
            tabTitle,
            message: `${Math.abs(delta)} ft overlap: row ${k + 1} ends at ${cur.endRaw} but row ${k + 2} starts at ${next.startRaw}`,
            rows: [k + 1, k + 2],
          });
        }
      }
    }

    // ---- duplicate keys within the tab ----
    const keyCol = keyColumn ?? null;
    if (keyCol !== null && keyCol < data.headers.length) {
      const seen = new Map<string, number[]>();
      data.rows.forEach((r, i) => {
        const k = normalizeKey(r[keyCol]);
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
            message: `“${k}” appears ${rowNums.length}× (rows ${rowNums.join(", ")}) — duplicate shot?`,
            rows: rowNums,
          });
        }
      }
    }
  }

  // ---- same key in multiple tabs ----
  const keyOwners = new Map<string, { tab: string; row: number }[]>();
  for (const { tabTitle, data, keyColumn } of tabs) {
    if (keyColumn === null || keyColumn >= data.headers.length) continue;
    data.rows.forEach((r, i) => {
      const k = normalizeKey(r[keyColumn]);
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
        message: `“${k}” appears in ${[...uniqueTabs].join(" and ")} — should be in only one`,
        rows: owners.map((o) => o.row),
      });
    }
  }

  return findings;
}
