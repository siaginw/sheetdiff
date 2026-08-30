/**
 * The snapshot diff engine — pure logic, no I/O.
 *
 * Design constraints (see plan):
 *  - Rows are never identified by position. Sorting a sheet must not produce
 *    false changes: rows are matched by a key column when available, else by
 *    full-row content, with positional pairing only as a last resort.
 *  - Values are compared through `sameValue` so "40", "40.00" and "$40" are
 *    equal (numbers) while any textual difference stays a real change.
 *  - Columns are matched by header text (first row), so column inserts in the
 *    middle of a sheet don't scramble cell pairing. One leftover column on
 *    each side is paired positionally so a header rename is not reported as
 *    remove+add.
 */

import { norm, sameValue, normalizeKey, rowHash, colLetter, hashString, compositeKey } from "./normalize";
import { detectStationColumns, detectActivityColumn } from "../detect";

export interface SnapshotData {
  headers: string[];
  rows: string[][];
}

export interface CellDiff {
  col: number; // column index in the newer snapshot (B space)
  header: string;
  from: string;
  to: string;
}

export type RowStatus = "added" | "removed" | "changed" | "moved" | "unchanged";

/** Stable content identity of a row. The rowKey fallback AND the ack
 *  introduction walk MUST produce the same string — hence one definition. */
export function rowContentKey(values: readonly string[]): string {
  return hashString(values.map(norm).join("\u0000"));
}

/** The OLD (A-side) values of a changed row, reconstructed from B's values. */
export function oldRowValues(row: DiffRow): string[] {
  const out = row.values.slice();
  for (const c of row.cells) out[c.col] = c.from;
  return out;
}

export interface DiffRow {
  status: RowStatus;
  key: string | null;
  /** stable row identity (key column value, else content hash) — used by acks/notes */
  rowKey: string;
  /** data-row index (0-based, excluding header) in A / B, null when absent */
  oldIndex: number | null;
  newIndex: number | null;
  /** set when the row changed AND moved (key-matched only) */
  movedFrom: number | null;
  /** changed cells (status === "changed") */
  cells: CellDiff[];
  /** display values: B's row, or A's row when status === "removed" */
  values: string[];
}

export interface ColumnInfo {
  col: number; // B space
  header: string;
  status: "same" | "added";
}

export interface DiffSummary {
  addedRows: number;
  removedRows: number;
  changedRows: number;
  movedRows: number;
  unchangedRows: number;
  changedCells: number;
  columnsAdded: string[];
  columnsRemoved: string[];
  keyColumnIndex: number | null;
  keyColumnHeader: string | null;
  fromWhen: number | null;
  toWhen: number | null;
}

export interface DiffResult {
  summary: DiffSummary;
  columns: ColumnInfo[];
  rows: DiffRow[];
}

export interface DiffOptions {
  /** explicit key column (B space); null/undefined -> auto-detect */
  keyColumn?: number | null;
  fromWhen?: number | null;
  toWhen?: number | null;
}

const KEY_HEADER_RE = /^(id|key|code|ref|no|num|number|item|row|sku|po|job|ticket|emp|employee|date|week|site|unit)$/i;

/**
 * Auto-detect the column that identifies rows. A column qualifies when its
 * values are non-empty for ~all rows and unique. Header names that look like
 * identifiers win ties; leftmost wins remaining ties.
 */
export function detectKeyColumn(s: SnapshotData): number | null {
  const { headers, rows } = s;
  if (rows.length < 2) return null;
  // station columns are positions, never identities — without this, a small
  // tracker's unique End STA column silently keys the diff and the mechanism
  // flips to content-hash as soon as two shots share an end station
  const stations = detectStationColumns(s);
  const banned = new Set(stations ? [stations.start, stations.end] : []);
  const width = headers.length;
  let best: { col: number; score: number } | null = null;

  const scanCols = Math.min(width, 12);
  for (let c = 0; c < scanCols; c++) {
    if (banned.has(c)) continue;
    const values = rows.map((r) => normalizeKey(r[c]));
    const nonEmpty = values.filter((v) => v !== "");
    if (nonEmpty.length === 0) continue;
    // Keys must exist for essentially every row
    if (nonEmpty.length < rows.length * 0.9) continue;
    // ...and be unique (a key that repeats can't identify a row)
    if (new Set(nonEmpty).size !== nonEmpty.length) continue;

    const header = norm(headers[c]).toLowerCase();
    const score =
      (KEY_HEADER_RE.test(header) ? 2 : 0) +
      (header.includes("id") || header.includes("key") || header.includes("date") ? 1 : 0);
    if (!best || score > best.score) best = { col: c, score };
  }
  return best ? best.col : null;
}

/**
 * Composite row identity for trackers that can't have an ID column:
 * Activity + Start station + End station ("the 14800–15743 plow"). Qualifies
 * when all three columns exist and the combination is essentially unique.
 */
export function detectCompositeKey(s: SnapshotData): number[] | null {
  if (s.rows.length < 2) return null;
  const stations = detectStationColumns(s);
  const activity = detectActivityColumn(s);
  if (!stations || activity === null) return null;
  const cols = [activity, stations.start, stations.end];
  const seen = new Set<string>();
  let nonEmpty = 0;
  for (const row of s.rows) {
    const k = compositeKey(row, cols);
    if (k === "") continue;
    nonEmpty++;
    seen.add(k);
  }
  if (nonEmpty < 2) return null;
  if (seen.size < nonEmpty * 0.9) return null; // combos must be ~unique to identify rows
  return cols;
}

/** Map B columns -> A columns (null = column is new in B). */
function matchColumns(a: SnapshotData, b: SnapshotData): {
  aToB: (number | null)[]; // A col index -> B col index
  bToA: (number | null)[]; // B col index -> A col index
  added: number[]; // B cols with no A counterpart
  removed: number[]; // A cols with no B counterpart
} {
  const aWidth = Math.max(a.headers.length, ...a.rows.map((r) => r.length), 0);
  const bWidth = Math.max(b.headers.length, ...b.rows.map((r) => r.length), 0);
  const aToB: (number | null)[] = new Array(aWidth).fill(null);
  const bToA: (number | null)[] = new Array(bWidth).fill(null);

  // Pass 1: match by normalized header text (first occurrence wins).
  const aHeaderMap = new Map<string, number[]>();
  for (let c = 0; c < aWidth; c++) {
    const h = norm(a.headers[c]);
    if (h === "" && c >= a.headers.length) continue;
    if (h === "") continue;
    const list = aHeaderMap.get(h) ?? [];
    list.push(c);
    aHeaderMap.set(h, list);
  }
  for (let c = 0; c < bWidth; c++) {
    const h = norm(b.headers[c]);
    if (h === "") continue;
    const candidates = aHeaderMap.get(h);
    while (candidates && candidates.length > 0) {
      const ac = candidates.shift()!;
      if (aToB[ac] === null) {
        aToB[ac] = c;
        bToA[c] = ac;
        break;
      }
    }
  }

  let leftoverA: number[] = [];
  let leftoverB: number[] = [];
  for (let c = 0; c < aWidth; c++) if (aToB[c] === null) leftoverA.push(c);
  for (let c = 0; c < bWidth; c++) if (bToA[c] === null) leftoverB.push(c);

  // Pass 2: equal leftover counts -> pair positionally (header rename case).
  if (leftoverA.length === leftoverB.length && leftoverB.length > 0) {
    for (let i = 0; i < leftoverB.length; i++) {
      aToB[leftoverA[i]] = leftoverB[i];
      bToA[leftoverB[i]] = leftoverA[i];
    }
    leftoverA = [];
    leftoverB = [];
  }

  return { aToB, bToA, added: leftoverB, removed: leftoverA };
}

function rowGet(row: string[] | undefined, c: number): string {
  return norm(row?.[c]);
}

export function diffSnapshots(a: SnapshotData, b: SnapshotData, opts: DiffOptions = {}): DiffResult {
  const cols = matchColumns(a, b);

  // ---- key column resolution (B space) ----
  let keyCol = opts.keyColumn ?? null;
  if (keyCol !== null && (keyCol < 0 || keyCol >= b.headers.length)) keyCol = null;
  if (keyCol === null) keyCol = detectKeyColumn(b);
  const keyColA = keyCol !== null ? cols.bToA[keyCol] ?? null : null;

  // composite identity (Activity + stations) when no single key exists —
  // usable only when every composite column maps into A
  const compositeCols = keyCol === null ? detectCompositeKey(b) : null;
  const compositeColsA = compositeCols?.map((c) => cols.bToA[c] ?? null) ?? null;
  const compositeUsable = compositeCols !== null && compositeColsA !== null && compositeColsA.every((c) => c !== null);

  const keyOfB = (row: string[]): string => {
    if (keyCol !== null) return normalizeKey(row[keyCol]);
    if (compositeUsable && compositeCols) return compositeKey(row, compositeCols);
    return "";
  };
  const keyOfA = (row: string[]): string => {
    if (keyCol !== null && keyColA !== null) return normalizeKey(row[keyColA]);
    if (compositeUsable && compositeCols && compositeColsA) {
      return compositeKey(row, compositeColsA as number[]);
    }
    return "";
  };

  // ---- row matching ----
  // matchedA[i] = B row index matched to A row i (or -1)
  // matchB[k] = A row index matched to B row k (or -1)
  const matchedA = new Array(a.rows.length).fill(-1);
  const matchB = new Array(b.rows.length).fill(-1);

  const sharedACols: number[] = [];
  for (let ac = 0; ac < cols.aToB.length; ac++) if (cols.aToB[ac] !== null) sharedACols.push(ac);

  if ((keyCol !== null && keyColA !== null) || compositeUsable) {
    const queues = new Map<string, number[]>();
    for (let i = 0; i < a.rows.length; i++) {
      const k = keyOfA(a.rows[i]);
      if (k === "") continue; // blank keys are not identities
      const q = queues.get(k) ?? [];
      q.push(i);
      queues.set(k, q);
    }
    for (let k = 0; k < b.rows.length; k++) {
      const key = keyOfB(b.rows[k]);
      if (key === "") continue;
      const q = queues.get(key);
      if (q && q.length > 0) {
        const i = q.shift()!;
        matchB[k] = i;
        matchedA[i] = k;
      }
    }
  } else {
    // Content hashing over shared columns, then positional pairing of leftovers.
    const queues = new Map<string, number[]>();
    for (let i = 0; i < a.rows.length; i++) {
      const h = rowHash(a.rows[i], sharedACols);
      if (h === "\u0000".repeat(sharedACols.length)) continue; // fully empty row
      const q = queues.get(h) ?? [];
      q.push(i);
      queues.set(h, q);
    }
    const unmatchedB: number[] = [];
    for (let k = 0; k < b.rows.length; k++) {
      const h = rowHash(b.rows[k], sharedACols.map((ac) => cols.aToB[ac]!));
      if (h === "\u0000".repeat(sharedACols.length)) {
        unmatchedB.push(k);
        continue;
      }
      const q = queues.get(h);
      if (q && q.length > 0) {
        const i = q.shift()!;
        matchB[k] = i;
        matchedA[i] = k;
      } else {
        unmatchedB.push(k);
      }
    }
    // Leftover rows pair positionally, but never blank ones — a stray blank
    // row must show as added/removed, not as a "change" from nothing.
    const blankA = (vals: string[]) => sharedACols.every((c) => norm(vals[c]) === "");
    const blankB = (vals: string[]) =>
      sharedACols.every((ac) => norm(vals[cols.aToB[ac]!]) === "");
    const leftoverA: number[] = [];
    for (let i = 0; i < a.rows.length; i++) {
      if (matchedA[i] === -1 && !blankA(a.rows[i])) leftoverA.push(i);
    }
    const leftoverB = unmatchedB.filter((k) => !blankB(b.rows[k]));
    let bi = 0;
    for (const i of leftoverA) {
      if (bi >= leftoverB.length) break;
      const k = leftoverB[bi++];
      matchB[k] = i;
      matchedA[i] = k;
    }
  }

  // ---- cell diffs for matched rows ----
  const summary: DiffSummary = {
    addedRows: 0,
    removedRows: 0,
    changedRows: 0,
    movedRows: 0,
    unchangedRows: 0,
    changedCells: 0,
    columnsAdded: cols.added.map((c) => norm(b.headers[c]) || colLetter(c)),
    columnsRemoved: cols.removed.map((c) => norm(a.headers[c]) || colLetter(c)),
    keyColumnIndex: keyCol,
    keyColumnHeader:
      keyCol !== null
        ? norm(b.headers[keyCol]) || colLetter(keyCol)
        : compositeUsable && compositeCols
          ? compositeCols.map((c) => norm(b.headers[c]) || colLetter(c)).join(" + ")
          : null,
    fromWhen: opts.fromWhen ?? null,
    toWhen: opts.toWhen ?? null,
  };

  const changedCellCount = (k: number, i: number): { cells: CellDiff[] } => {
    const cells: CellDiff[] = [];
    const aRow = a.rows[i];
    const bRow = b.rows[k];
    for (let bc = 0; bc < b.headers.length; bc++) {
      const ac = cols.bToA[bc];
      if (ac === null || ac === undefined) continue;
      const av = rowGet(aRow, ac);
      const bv = rowGet(bRow, bc);
      if (!sameValue(av, bv)) {
        cells.push({ col: bc, header: norm(b.headers[bc]) || colLetter(bc), from: av, to: bv });
      }
    }
    return { cells };
  };

  const diffRows: DiffRow[] = [];

  const emitB = (k: number) => {
    const i = matchB[k];
    const rawKey = keyOfB(b.rows[k]);
    const key = rawKey === "" ? null : rawKey;
    // stable identity for acks: key column when present, else hash of the OLD
    // row (stable across value edits, so a re-change after an ack re-flags it)
    const rowKey = key ?? rowContentKey(i === -1 ? b.rows[k] : a.rows[i]);
    if (i === -1) {
      summary.addedRows++;
      diffRows.push({
        status: "added",
        key,
        rowKey,
        oldIndex: null,
        newIndex: k,
        movedFrom: null,
        cells: [],
        values: b.rows[k].map((v) => norm(v)),
      });
      return;
    }
    const { cells } = changedCellCount(k, i);
    const movedFrom = i !== k ? i : null;
    if (cells.length > 0) {
      summary.changedRows++;
      summary.changedCells += cells.length;
      diffRows.push({
        status: "changed",
        key,
        rowKey,
        oldIndex: i,
        newIndex: k,
        movedFrom,
        cells,
        values: b.rows[k].map((v) => norm(v)),
      });
    } else if (movedFrom !== null) {
      summary.movedRows++;
      diffRows.push({
        status: "moved",
        key,
        rowKey,
        oldIndex: i,
        newIndex: k,
        movedFrom,
        cells: [],
        values: b.rows[k].map((v) => norm(v)),
      });
    } else {
      summary.unchangedRows++;
      // unchanged rows are still emitted; the UI hides them by default
      diffRows.push({
        status: "unchanged",
        key,
        rowKey,
        oldIndex: i,
        newIndex: k,
        movedFrom: null,
        cells: [],
        values: b.rows[k].map((v) => norm(v)),
      });
    }
  };

  const emitRemoved = (i: number) => {
    summary.removedRows++;
    const removedRaw = keyOfA(a.rows[i]);
    const removedKey = removedRaw === "" ? null : removedRaw;
    diffRows.push({
      status: "removed",
      key: removedKey,
      rowKey: removedKey ?? rowContentKey(a.rows[i]),
      oldIndex: i,
      newIndex: null,
      movedFrom: null,
      cells: [],
      values: a.rows[i].map((v) => norm(v)),
    });
  };

  // ---- output order: B order, with removed rows interleaved at their old spot ----
  const removedIdx: number[] = [];
  for (let i = 0; i < a.rows.length; i++) if (matchedA[i] === -1) removedIdx.push(i);
  let ri = 0;
  for (let k = 0; k < b.rows.length; k++) {
    emitB(k);
    // next B row's A-index (Infinity for added rows) gates which removed rows belong here
    const nextOld = k + 1 < b.rows.length && matchB[k + 1] !== -1 ? matchB[k + 1] : Infinity;
    while (ri < removedIdx.length && removedIdx[ri] < nextOld) emitRemoved(removedIdx[ri++]);
  }
  while (ri < removedIdx.length) emitRemoved(removedIdx[ri++]);

  const columns: ColumnInfo[] = b.headers.map((h, c) => ({
    col: c,
    header: norm(h) || colLetter(c),
    status: cols.added.includes(c) ? "added" : "same",
  }));

  return { summary, columns, rows: diffRows };
}
