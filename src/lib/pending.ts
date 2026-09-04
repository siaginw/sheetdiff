import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "./db";
import { snapshots, snapshotStats, type Snapshot, type Tab } from "./db/schema";
import { diffSnapshots, type DiffResult, type DiffRow, type SnapshotData } from "./diff/engine";
import { peekSnapshot, rememberSnapshot } from "./snapshot-cache";
import { latestNonImportSnapshots } from "./snapshots";
import { computeIntroductions, getAckMap, isResolved, keySetsFor, type WalkSnapshot } from "./sync";

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
  /** rowKey -> introduction time (only meaningful when acks exist); shared so
   *  the sheet page can resolve acks EXACTLY like the badge/CSV/digest do */
  introducedAt: Map<string, number>;
}

interface TabSnapshotMeta {
  id: string;
  createdAt: number;
  isBaseline: boolean;
  trigger: string;
}

/** Snapshot metadata for one tab, newest first, GIS imports excluded. */
async function loadSheetMeta(tabId: string): Promise<TabSnapshotMeta[]> {
  return db
    .select({
      id: snapshots.id,
      createdAt: snapshots.createdAt,
      isBaseline: snapshots.isBaseline,
      trigger: snapshots.trigger,
    })
    .from(snapshots)
    .where(eq(snapshots.tabId, tabId))
    .orderBy(desc(snapshots.createdAt));
}

/**
 * Whether the tab has a COLLECTED BASELINE to diff against (and when its
 * latest capture ran). getPendingChanges returns null for quiet tabs too —
 * callers that need to tell "nothing collected yet" from "collected, quiet
 * since" (the entry queue's no-collection-point message) ask here instead of
 * guessing from the null.
 */
export async function hasCollectedBaseline(tab: Pick<Tab, "id">): Promise<{ latestAt: number } | null> {
  const sheetSnaps = (await loadSheetMeta(tab.id)).filter((s) => s.trigger !== "import");
  const latest = sheetSnaps[0];
  const baseline = sheetSnaps.find((s) => s.isBaseline && s.createdAt <= latest?.createdAt);
  if (!latest || !baseline) return null;
  return { latestAt: latest.createdAt };
}

export async function getPendingChanges(tab: Pick<Tab, "id" | "keyColumn">): Promise<PendingChanges | null> {
  const sheetSnaps = (await loadSheetMeta(tab.id)).filter((s) => s.trigger !== "import");
  const latest = sheetSnaps[0];
  const baseline = sheetSnaps.find((s) => s.isBaseline && s.createdAt <= latest?.createdAt);
  if (!latest || !baseline || latest.id === baseline.id) return null;

  // QUIET-DAY SHORT-CIRCUIT: sum the materialized capture-time stats over
  // (baseline, latest] — when every row is 0/0/0 (the common hourly case) there
  // is nothing pending and the 2-blob diff + ack walk never run. Falls
  // through to the full path when stats are missing (legacy) or non-zero.
  const statRows = await db
    .select({
      snapshotId: snapshotStats.snapshotId,
      added: snapshotStats.added,
      removed: snapshotStats.removed,
      changed: snapshotStats.changed,
    })
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
  const windowSnaps = sheetSnaps.filter((s) => s.createdAt > baseline.createdAt && s.createdAt <= latest.createdAt);
  const statIds = new Set(statRows.map((r) => r.snapshotId));
  const completeCoverage = windowSnaps.length > 0 && windowSnaps.every((s) => statIds.has(s.id));
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

  const ackMap = await getAckMap(tab.id);

  // Introduction walk: the full window from baseline (exclusive) to latest,
  // WITH the baseline as the bounding anchor — its blob is already loaded, and
  // with it every row's introduction is exact (a row can't predate the window
  // the diff spans). Capped for pathological retention-fueled windows; a capped
  // walk dates unbounded rows at its own oldest edge (re-flag direction, never
  // a silent miss).
  // Runs whenever there is anything to DATE, not just when acks exist: a
  // fresh sheet with no acks yet still wants oldest-first ordering (the entry
  // queue's primary sort). The quiet-day short-circuit above already keeps the
  // common no-change case free of the walk's blob fetches.
  const windowAll = sheetSnaps.filter((s) => s.createdAt > baseline.createdAt && s.createdAt <= latest.createdAt);
  let introducedAt = new Map<string, number>();
  if ((ackMap.size > 0 || changeRows.length > 0) && windowAll.length > 0) {
    const walkSnaps = windowAll.slice(0, INTRO_WALK_LIMIT).concat([baseline]);
    const walkBlobs = await fetchBlobs(walkSnaps.map((s) => s.id));
    const walk: WalkSnapshot[] = walkSnaps
      .map((s) => ({ createdAt: s.createdAt, data: walkBlobs.get(s.id) }))
      .filter((w): w is WalkSnapshot => Boolean(w.data));
    introducedAt = computeIntroductions(walk, diff.rows, { keySets: keySetsFor(diff, walk) });
  }

  // no acks at all → everything pending, no resolution filtering (the walk ran
  // above purely to date the rows for oldest-first ordering)
  if (ackMap.size === 0) {
    return {
      diff,
      latestAt: latest.createdAt,
      baselineAt: baseline.createdAt,
      unresolved: changeRows,
      counts,
      introducedAt,
    };
  }

  const unresolved = changeRows.filter(
    (r) => !isResolved(ackMap, r.rowKey, introducedAt.get(r.rowKey) ?? latest.createdAt),
  );
  counts.unresolved = unresolved.length;
  return {
    diff,
    latestAt: latest.createdAt,
    baselineAt: baseline.createdAt,
    unresolved,
    counts,
    introducedAt,
  };
}

async function fetchBlobs(ids: string[]): Promise<Map<string, SnapshotData>> {
  if (ids.length === 0) return new Map();
  const out = new Map<string, SnapshotData>();
  const misses: string[] = [];
  for (const id of ids) {
    const hit = peekSnapshot(id);
    if (hit) out.set(id, hit);
    else misses.push(id);
  }
  if (misses.length > 0) {
    const rows: Snapshot[] = await db.select().from(snapshots).where(inArray(snapshots.id, misses));
    for (const r of rows) out.set(r.id, rememberSnapshot(r.id, r.dataBlob));
  }
  return out;
}

/** Tab ids whose LATEST content is fully owned by earlier tabs — pure
 *  compilation tabs (a Line List that re-lists the working tabs' shots).
 *  Every TO-ENTER count surface (dashboard badge, sheet page, both typing
 *  CSVs, digest, billing) skips these: the working tabs' own pending already
 *  lists that work, and counting both would promise the office two entries
 *  for one shot. One classifier, so every surface agrees by construction. */
export async function pureCopyTabIds(tabRows: Tab[]): Promise<Set<string>> {
  const { dedupeTabData } = await import("./dedupe");
  const tracked = tabRows.filter((t) => t.tracked).sort((a, b) => a.position - b.position);
  if (tracked.length === 0) return new Set();
  const latestByTab = await latestNonImportSnapshots(tracked.map((t) => t.id));
  const grids: { title: string; data: SnapshotData; keyColumn?: number | null }[] = [];
  for (const t of tracked) {
    const snap = latestByTab.get(t.id);
    if (snap) grids.push({ title: t.title, data: rememberSnapshot(snap.id, snap.dataBlob), keyColumn: t.keyColumn });
  }
  if (grids.length === 0) return new Set();
  const { pureCopies } = dedupeTabData(grids);
  return new Set(tracked.filter((t) => pureCopies.has(t.title)).map((t) => t.id));
}
