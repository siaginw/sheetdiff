import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { changeAcks } from "./db/schema";

/**
 * Per-change sync acknowledgment resolution.
 *
 * A change is resolved when its ack timestamp is >= the createdAt of the
 * snapshot that introduced the changed state (the "to" side of the pending
 * diff). If the row changes again later, the new snapshot is newer than the
 * ack and the change re-flags itself as unresolved.
 */

export async function getAckMap(tabId: string): Promise<Map<string, number>> {
  const rows = await db.select().from(changeAcks).where(eq(changeAcks.tabId, tabId));
  return new Map(rows.map((r) => [r.rowKey, r.ackedAt]));
}

export function isResolved(ackMap: Map<string, number>, rowKey: string, introducedAt: number): boolean {
  const ackedAt = ackMap.get(rowKey);
  return ackedAt !== undefined && ackedAt >= introducedAt;
}

export async function setAck(tabId: string, rowKey: string, on: boolean): Promise<void> {
  if (on) {
    const existing = await db
      .select()
      .from(changeAcks)
      .where(and(eq(changeAcks.tabId, tabId), eq(changeAcks.rowKey, rowKey)))
      .limit(1);
    if (existing[0]) {
      await db.update(changeAcks).set({ ackedAt: Date.now() }).where(eq(changeAcks.id, existing[0].id));
    } else {
      await db.insert(changeAcks).values({
        id: crypto.randomUUID(),
        tabId,
        rowKey,
        ackedAt: Date.now(),
      });
    }
  } else {
    await db
      .delete(changeAcks)
      .where(and(eq(changeAcks.tabId, tabId), eq(changeAcks.rowKey, rowKey)));
  }
}
