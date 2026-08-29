import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { changeAcks } from "./db/schema";
import type { DiffRow, SnapshotData } from "./diff/engine";
import { norm, hashString } from "./diff/normalize";

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

/** Row identity for snapshot-content lookups: hash of normalized values. */
function contentHash(values: string[]): string {
  return hashString(values.map(norm).join("\u0000"));
}

function oldRowValues(row: DiffRow): string[] {
  const out = row.values.slice();
  for (const c of row.cells) out[c.col] = c.from;
  return out;
}

export interface WalkSnapshot {
  createdAt: number;
  data: SnapshotData;
}

/**
 * Compute when each diff row's current state first appeared.
 *
 * `walk` must be the snapshots from baseline (exclusive) to latest (inclusive),
 * ordered NEWEST first, capped to a reasonable window (e.g. 30). For
 * added/changed rows the introduction is the oldest walked snapshot still
 * containing the row's NEW content hash; for removed rows, the oldest snapshot
 * in which the OLD content hash is gone.
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
        hash: contentHash(oldRowValues(row)),
        mode: "absent",
      });
    } else {
      pending.set(row.rowKey, {
        introduced: 0,
        done: false,
        hash: contentHash(row.values),
        mode: "present",
      });
    }
  }

  for (const snap of walk) {
    if ([...pending.values()].every((p) => p.done)) break;
    const hashes = new Set(snap.data.rows.map((r) => contentHash(r)));
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
