import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { snapshots, changeAcks, type Snapshot, type Tab } from "./db/schema";
import { diffSnapshots, type DiffResult, type DiffRow, type SnapshotData } from "./diff/engine";
import { decodeSnapshot } from "./snapshots";
import { getAckMap, isResolved, computeIntroductions, type WalkSnapshot } from "./sync";

/**
 * The pending-change set for one tab: the diff from the latest baseline to
 * the latest SHEET snapshot (GIS imports excluded), minus changes already
 * acknowledged as entered downstream. Shared by the dashboard, the CSV
 * export, and the digest so all three can never disagree.
 *
 * Loads snapshot metadata first and fetches only the blobs it needs
 * (baseline + latest + a bounded walk window) — never the whole history.
 */

const INTRO_WALK_LIMIT = 30;

export interface PendingChanges {
  diff: DiffResult;
  latestAt: number;
  baselineAt: number;
  /** changed/added/removed rows still to enter downstream */
  unresolved: DiffRow[];
  counts: { added: number; removed: number; changed: number; unresolved: number };
}

export async function getPendingChanges(
  tab: Pick<Tab, "id" | "keyColumn">,
): Promise<PendingChanges | null> {
  const meta = await db
    .select({
      id: snapshots.id,
      createdAt: snapshots.createdAt,
      isBaseline: snapshots.isBaseline,
      trigger: snapshots.trigger,
    })
    .from(snapshots)
    .where(eq(snapshots.tabId, tab.id))
    .orderBy(desc(snapshots.createdAt));

  const sheetSnaps = meta.filter((s) => s.trigger !== "import");
  const latest = sheetSnaps[0];
  const baseline = sheetSnaps.find((s) => s.isBaseline && s.createdAt <= latest?.createdAt);
  if (!latest || !baseline || latest.id === baseline.id) return null;

  const blobs = await fetchBlobs([latest.id, baseline.id]);
  const latestData = blobs.get(latest.id);
  const baselineData = blobs.get(baseline.id);
  if (!latestData || !baselineData) return null;

  const diff = diffSnapshots(baselineData, latestData, {
    keyColumn: tab.keyColumn ?? null,
    fromWhen: baseline.createdAt,
    toWhen: latest.createdAt,
  });
  const changeRows = diff.rows.filter((r) => r.status !== "unchanged" && r.status !== "moved");
  const counts = {
    added: diff.summary.addedRows,
    removed: diff.summary.removedRows,
    changed: diff.summary.changedRows,
    unresolved: changeRows.length,
  };

  // no acks at all → everything pending, skip the walk entirely
  const ackMap = await getAckMap(tab.id);
  if (ackMap.size === 0) {
    return { diff, latestAt: latest.createdAt, baselineAt: baseline.createdAt, unresolved: changeRows, counts };
  }

  // bounded walk between baseline and latest (newest first, baseline excluded)
  const between = sheetSnaps
    .filter((s) => s.createdAt > baseline.createdAt && s.createdAt <= latest.createdAt)
    .slice(0, INTRO_WALK_LIMIT);
  let introducedAt = new Map<string, number>();
  if (between.length > 1) {
    const walkBlobs = await fetchBlobs(between.map((s) => s.id));
    const walk: WalkSnapshot[] = between
      .map((s) => ({ createdAt: s.createdAt, data: walkBlobs.get(s.id) }))
      .filter((w): w is WalkSnapshot => Boolean(w.data));
    introducedAt = computeIntroductions(walk, diff.rows);
  }

  const unresolved = changeRows.filter(
    (r) => !isResolved(ackMap, r.rowKey, introducedAt.get(r.rowKey) ?? latest.createdAt),
  );
  counts.unresolved = unresolved.length;
  return { diff, latestAt: latest.createdAt, baselineAt: baseline.createdAt, unresolved, counts };
}

async function fetchBlobs(ids: string[]): Promise<Map<string, SnapshotData>> {
  if (ids.length === 0) return new Map();
  const rows: Snapshot[] = await db.select().from(snapshots).where(inArray(snapshots.id, ids));
  return new Map(rows.map((r) => [r.id, decodeSnapshot(r.dataBlob)]));
}
