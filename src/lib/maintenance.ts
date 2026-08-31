import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { snapshots, tabs } from "./db/schema";

/**
 * Daily maintenance: snapshot retention + database backup.
 * Runs from the scheduler on the first tick after 3am local time.
 *
 * Retention rule: per tracked tab, always keep baselines and the newest
 * SHEETDIFF_KEEP_SNAPSHOTS non-baseline snapshots (default 200, <=0 = keep
 * everything), but never prune a tab down below 2 non-baseline snapshots.
 * GIS imports count toward the limit like any snapshot.
 */

const globalForMaint = globalThis as unknown as { __sheetdiffMaintDay?: string };

export function maintenanceDue(now = new Date()): boolean {
  if (now.getHours() < 3) return false;
  const day = now.toDateString();
  if (globalForMaint.__sheetdiffMaintDay === day) return false;
  globalForMaint.__sheetdiffMaintDay = day;
  return true;
}

export async function pruneSnapshots(): Promise<number> {
  const keep = Number(process.env.SHEETDIFF_KEEP_SNAPSHOTS ?? 200);
  if (!Number.isFinite(keep) || keep <= 0) return 0;

  const allTabs = await db.select().from(tabs);
  let deleted = 0;
  for (const tab of allTabs) {
    const rows = await db
      .select({ id: snapshots.id, isBaseline: snapshots.isBaseline })
      .from(snapshots)
      .where(eq(snapshots.tabId, tab.id))
      .orderBy(desc(snapshots.createdAt));
    const nonBaseline = rows.filter((r) => !r.isBaseline);
    if (nonBaseline.length <= Math.max(keep, 2)) continue;
    const doomed = nonBaseline.slice(Math.max(keep, 2)).map((r) => r.id);
    if (doomed.length > 0) {
      await db.delete(snapshots).where(inArray(snapshots.id, doomed));
      deleted += doomed.length;
    }
  }
  return deleted;
}

/** Online-backup the SQLite file to data/backups/, keeping the newest N.
 *  better-sqlite3's .backup() is ASYNC (paged transfer on the event loop) —
 *  it must be awaited before the connection closes. */
export async function backupDatabase(): Promise<string | null> {
  const keep = Number(process.env.SHEETDIFF_BACKUPS ?? 14);
  if (!Number.isFinite(keep) || keep <= 0) return null;

  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "sheetdiff.db");
  const dir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(dir, `sheetdiff-${stamp}.db`);
  if (fs.existsSync(dest)) return dest; // already backed up today

  const sqlite = new Database(dbPath, { readonly: true });
  try {
    await sqlite.backup(dest);
    // an unverified backup is a hope, not a backup
    const check = new Database(dest, { readonly: true });
    try {
      const result = check.pragma("integrity_check", { simple: true });
      if (result !== "ok") console.error(`[maintenance] backup integrity_check: ${String(result)}`);
    } finally {
      check.close();
    }
  } finally {
    sqlite.close();
  }

  const old = fs
    .readdirSync(dir)
    .filter((f) => (f.startsWith("sheetdiff-") || f.startsWith("pre-migrate-")) && f.endsWith(".db"))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) {
    try {
      fs.rmSync(path.join(dir, f));
    } catch {
      // best effort
    }
  }
  return dest;
}

/** One maintenance pass; safe to call from the scheduler tick. */
export async function runMaintenance(): Promise<void> {
  try {
    // long-lived connection hygiene: complete the WAL + refresh query plans
    const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "sheetdiff.db");
    const pragmaDb = new Database(dbPath);
    try {
      pragmaDb.pragma("wal_checkpoint(TRUNCATE)");
      pragmaDb.pragma("optimize");
    } finally {
      pragmaDb.close();
    }
    const pruned = await pruneSnapshots();
    const backup = await backupDatabase();
    if (pruned > 0 || backup) {
      console.log(`[maintenance] pruned ${pruned} snapshot(s)${backup ? `, backup → ${path.basename(backup)}` : ""}`);
    }
  } catch (err) {
    console.error("[maintenance] failed:", err instanceof Error ? err.message : err);
  }
}
