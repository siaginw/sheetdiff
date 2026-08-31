import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { changeAcks } from "./db/schema";
import { rowContentKey, oldRowValues, type DiffRow, type SnapshotData } from "./diff/engine";


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
 * containing the row's NEW content hash; for removed rows, the oldest
 * snapshot in which the OLD content hash is gone.
 */
export function computeIntroductions(
  walk: WalkSnapshot[],
  rows: DiffRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (walk.length === 0) return out;

  type Pending = {
    introduced: number;
    done: boolean;
    hash: string;
    // added/changed: keep walking while the NEW content is present;
    // removed: keep walking while the OLD content is absent
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
        mode: "absent",
      });
    } else {
      pending.set(row.rowKey, {
        introduced: 0,
        done: false,
        hash: rowContentKey(row.values),
        mode: "present",
      });
    }
  }

  for (const snap of walk) {
    if ([...pending.values()].every((p) => p.done)) break;
    const hashes = new Set(snap.data.rows.map(rowContentKey));
    for (const p of pending.values()) {
      if (p.done) continue;
      const isPresent = hashes.has(p.hash);
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
