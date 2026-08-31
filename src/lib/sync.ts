import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { changeAcks } from "./db/schema";
import { rowContentKey, oldRowValues, type DiffRow, type SnapshotData, type DiffResult } from "./diff/engine";
import { normalizeKey, compositeKey } from "./diff/normalize";


/**
 * Per-change sync acknowledgment resolution.
 *
 * A change is resolved when its ack timestamp is >= the createdAt of the
 * snapshot that ACTUALLY introduced the changed state. Introduced-at is
 * computed per row by walking snapshots backward from the latest while the
 * row's content is unchanged — so an ack survives later snapshots that didn't
 * touch the row, and re-flags the moment the row's content changes again.
 */

export async function getAckMap(tabId: string): Promise<Map<string, number>> {
  const rows = await db.select().from(changeAcks).where(eq(changeAcks.tabId, tabId));
  return new Map(rows.map((r) => [r.rowKey, r.ackedAt]));
}

export function isResolved(ackMap: Map<string, number>, rowKey: string, introducedAt: number): boolean {
  const ackedAt = ackMap.get(rowKey);
  return ackedAt !== undefined && ackedAt >= introducedAt;
}

export interface WalkSnapshot {
  createdAt: number;
  data: SnapshotData;
}

/**
 * Compute when each diff row's current state first appeared.
 *
 * `walk` must be the snapshots from the bounding snapshot (the baseline, or
 * the "from" of a viewed pair) to latest, ordered NEWEST first, WITH the
 * bounding snapshot included as the last entry: a row still unbounded at the
 * walk's oldest edge would otherwise get a "present/absent everywhere in the
 * window" date that is really "predates the window" — and a timestamp that
 * is too LATE turns a valid ack into a re-flag, while one that is too EARLY
 * (an explicit 0) lets an ack silently swallow a re-change (a real miss —
 * worse). The bounding snapshot makes every introduction exact.
 *
 * For added/changed rows the introduction is the oldest walked snapshot still
 * containing the row's NEW content hash. For removed rows, presence means the
 * ROW still existing — not the old content hash: a row that changed (v0→v1)
 * and was deleted later must date its REMOVAL, or the ack for the change
 * (same rowKey) silently swallows the deletion. Keyed removals track the key
 * (`opts.keySets`, parallel to `walk`, built from the diff's identity
 * columns); blank-keyed removals track the identical-content family COUNT
 * against the oldest walked snapshot — "2 of the 146 padding rows went away"
 * is dated when the count dropped, and stays dated while the survivors live.
 */
export function computeIntroductions(
  walk: WalkSnapshot[],
  rows: DiffRow[],
  opts: { keySets?: Set<string>[] } = {},
): Map<string, number> {
  const out = new Map<string, number>();
  if (walk.length === 0) return out;

  type Pending = {
    introduced: number;
    done: boolean;
    hash: string;
    key: string | null;
    // added/changed: keep walking while the NEW content is present;
    // removed: keep walking while the ROW is still gone
    mode: "present" | "absent";
  };
  const pending = new Map<string, Pending>();

  for (const row of rows) {
    if (row.status === "unchanged" || row.status === "moved") continue;
    if (row.status === "removed") {
      pending.set(row.rowKey, {
        introduced: 0,
        done: false,
        hash: rowContentKey(oldRowValues(row)),
        key: row.key,
        mode: "absent",
      });
    } else {
      pending.set(row.rowKey, {
        introduced: 0,
        done: false,
        hash: rowContentKey(row.values),
        key: null,
        mode: "present",
      });
    }
  }

  // per-snapshot content-hash COUNTS (not a set): identical-row families are
  // distinguished by how many of them exist, not whether one does
  const countsOf = (snap: WalkSnapshot) => {
    const m = new Map<string, number>();
    for (const r of snap.data.rows) {
      const h = rowContentKey(r);
      m.set(h, (m.get(h) ?? 0) + 1);
    }
    return m;
  };
  const snapshotCounts = walk.map(countsOf);
  // family size at the walk's oldest edge (the bounding snapshot when the
  // caller followed the contract) — the level whose drop IS the removal
  const oldest = snapshotCounts[snapshotCounts.length - 1]!;

  for (let i = 0; i < walk.length; i++) {
    if ([...pending.values()].every((p) => p.done)) break;
    const snap = walk[i]!;
    const cnt = snapshotCounts[i]!;
    const keys = opts.keySets?.[i];
    for (const p of pending.values()) {
      if (p.done) continue;
      const isPresent =
        p.mode === "present"
          ? (cnt.get(p.hash) ?? 0) > 0
          : p.key !== null && keys
            ? keys.has(p.key)
            : (cnt.get(p.hash) ?? 0) >= Math.max(oldest.get(p.hash) ?? 0, 1);
      if ((p.mode === "present") === isPresent) {
        p.introduced = snap.createdAt;
      } else {
        p.done = true;
      }
    }
  }

  // only emit rows the walk actually dated — an undated row (mismatch on the
  // newest walked snapshot) must fall back to the caller's strict default,
  // never to a sentinel 0 that any ack would satisfy
  for (const [rowKey, p] of pending) {
    if (p.introduced > 0) out.set(rowKey, p.introduced);
  }
  return out;
}

export async function setAck(tabId: string, rowKey: string, on: boolean): Promise<void> {
  if (on) {
    await db
      .insert(changeAcks)
      .values({ id: crypto.randomUUID(), tabId, rowKey, ackedAt: Date.now() })
      .onConflictDoUpdate({
        target: [changeAcks.tabId, changeAcks.rowKey],
        set: { ackedAt: Date.now() },
      });
  } else {
    await db
      .delete(changeAcks)
      .where(and(eq(changeAcks.tabId, tabId), eq(changeAcks.rowKey, rowKey)));
  }
}

/** Per-walk-snapshot sets of row identities (single key or composite), using
 *  the diff's OWN resolution — lets removed rows be dated by when the ROW
 *  (its key) disappeared instead of when the old content value did. */
export function keySetsFor(
  diff: Pick<DiffResult, "identityColumns">,
  walk: WalkSnapshot[],
): Set<string>[] | undefined {
  const cols = diff.identityColumns;
  if (!cols) return undefined;
  return walk.map((w) =>
    new Set(
      w.data.rows.map((r) =>
        cols.length === 1 ? normalizeKey(r[cols[0]!]) : compositeKey(r, cols),
      ),
    ),
  );
}
