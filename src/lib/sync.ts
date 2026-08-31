import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { changeAcks } from "./db/schema";
import { rowContentKey, oldRowValues, type DiffRow, type SnapshotData, type DiffResult } from "./diff/engine";
import { normalizeKey, compositeKey, norm } from "./diff/normalize";


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
    // row position (newIndex for present rows, oldIndex for removed) — the
    // ordering heuristic for ranking members of a shared-content family
    rank: number | null;
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
        rank: row.oldIndex,
        mode: "absent",
      });
    } else {
      pending.set(row.rowKey, {
        introduced: 0,
        done: false,
        hash: rowContentKey(row.values),
        key: null,
        rank: row.newIndex,
        mode: "present",
      });
    }
  }

  // Multi-member families: when several pendings share one content hash, the
  // k-th member (by row order) dates at the count reaching oldest + k — each
  // member formed at its OWN moment. Without the ranking, two rows converging
  // to identical content one window apart both date at the FIRST convergence
  // and an ack in the gap swallows the second (fleet-10). Row order is a
  // heuristic for formation order (insertions above can swap it); a swap
  // mis-assigns WHICH member an ack covers, never the total.
  const rankInFamily = new Map<string, number>();
  for (const mode of ["present", "absent"] as const) {
    const fam = [...pending.entries()].filter(([, p]) => p.mode === mode && p.key === null);
    const byHash = new Map<string, { rowKey: string; rank: number | null }[]>();
    for (const [rowKey, p] of fam) {
      const list = byHash.get(p.hash) ?? [];
      list.push({ rowKey, rank: p.rank });
      byHash.set(p.hash, list);
    }
    for (const list of byHash.values()) {
      list.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      list.forEach((m, i) => rankInFamily.set(m.rowKey, i));
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
  // caller followed the contract): removals are dated when the count DROPPED
  // below their slot, and additions/changes when the count first EXCEEDED
  // theirs — a blank-key addition whose content matches existing family
  // members would otherwise be "present" all the way back to the anchor and a
  // stale ack could swallow it (fleet-9: the family shrank and regrew, the
  // regrowth went undated, the resolver went quiet on real unentered work).
  const oldest = snapshotCounts[snapshotCounts.length - 1]!;

  for (let i = 0; i < walk.length; i++) {
    if ([...pending.values()].every((p) => p.done)) break;
    const snap = walk[i]!;
    const cnt = snapshotCounts[i]!;
    const keys = opts.keySets?.[i];
    for (const [rowKey, p] of pending) {
      if (p.done) continue;
      const k = rankInFamily.get(rowKey) ?? 0;
      const isPresent =
        p.mode === "present"
          ? (cnt.get(p.hash) ?? 0) > (oldest.get(p.hash) ?? 0) + k
          : p.key !== null && keys
            ? keys.has(p.key)
            : (cnt.get(p.hash) ?? 0) >= Math.max((oldest.get(p.hash) ?? 0) - k, 1);
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
 *  (its key) disappeared instead of when the old content value did.
 *
 *  The identity indices are B-space (the latest snapshot's layout). If any
 *  walked snapshot's headers drift at those indices — a column inserted or
 *  deleted mid-window shifts the key column — the index would read the WRONG
 *  column for that snapshot and silently corrupt key presence. Rather than
 *  per-snapshot patching, bail to undefined entirely: the content-count walk
 *  is a consistent, if slightly blunter, fallback. */
export function keySetsFor(
  diff: Pick<DiffResult, "identityColumns">,
  walk: WalkSnapshot[],
): Set<string>[] | undefined {
  const cols = diff.identityColumns;
  if (!cols || walk.length === 0) return undefined;
  // Compare the ENTIRE header row (normalized), not just the identity indices:
  // a duplicate-header insert at an identity index leaves the header TEXT at
  // that index unchanged while shifting the real column right — index-based
  // comparison misses it and keys would be read from the junk column.
  const headersOf = (w: WalkSnapshot) => norm(w.data.headers.join("\u0000"));
  const latestHeaders = headersOf(walk[0]!);
  for (const w of walk) {
    if (headersOf(w) !== latestHeaders) return undefined;
  }
  return walk.map((w) =>
    new Set(
      w.data.rows.map((r) =>
        cols.length === 1 ? normalizeKey(r[cols[0]!]) : compositeKey(r, cols),
      ),
    ),
  );
}
