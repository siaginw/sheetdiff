import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "./db";
import { snapshots, snapshotStats, type Snapshot, type Tab } from "./db/schema";
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

const INTRO_WALK_LIMIT = 120; // safety cap; the baseline anchor bounds the walk below

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

  // QUIET-DAY SHORT-CIRCUIT: sum the materialized capture-time stats over
  // (baseline, latest] — when every row is 0/0/0 (the common hourly case) there
  // is nothing pending and the 2-blob diff + ack walk never run. Falls
  // through to the full path when stats are missing (legacy) or non-zero.
  const statRows = await db
    .select({ snapshotId: snapshotStats.snapshotId, added: snapshotStats.added, removed: snapshotStats.removed, changed: snapshotStats.changed })
    .from(snapshotStats)
    .where(
      and(
        eq(snapshotStats.tabId, tab.id),
        gt(snapshotStats.createdAt, baseline.createdAt),
        lte(snapshotStats.createdAt, latest.createdAt),
      ),
    );
  // COVERAGE GUARD: only trust "quiet" when EVERY snapshot in the window has a
  // stats row. Retention cascades delete stats with their snapshots, failed
  // stats inserts are skipped, and legacy rows predate the table — a hole in
  // the chain means unknown territory, never "no pending changes."
  const windowSnaps = sheetSnaps.filter(
    (s) => s.createdAt > baseline.createdAt && s.createdAt <= latest.createdAt,
  );
  const statIds = new Set(statRows.map((r) => r.snapshotId));
  const completeCoverage =
    windowSnaps.length > 0 && windowSnaps.every((s) => statIds.has(s.id));
  if (completeCoverage) {
    const quiet = statRows.every((r) => r.added === 0 && r.removed === 0 && r.changed === 0);
    if (quiet) return null;
  }

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

  // Introduction walk: the full window from baseline (exclusive) to latest,
  // WITH the baseline as the bounding anchor — its blob is already loaded, and
  // with it every row's introduction is exact (a row can't predate the window
  // the diff spans). Capped for pathological retention-fueled windows; a capped
  // walk dates unbounded rows at its own oldest edge (re-flag direction, never
  // a silent miss).
  const windowAll = sheetSnaps.filter(
    (s) => s.createdAt > baseline.createdAt && s.createdAt <= latest.createdAt,
  );
  let introducedAt = new Map<string, number>();
  if (windowAll.length > 0) {
    const walkSnaps = windowAll.slice(0, INTRO_WALK_LIMIT).concat([baseline]);
    const walkBlobs = await fetchBlobs(walkSnaps.map((s) => s.id));
    const walk: WalkSnapshot[] = walkSnaps
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
