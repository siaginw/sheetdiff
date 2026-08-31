import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Shared DB-test harness: one migrated temp SQLite database per test file.
 *
 * Contract (load-bearing): vitest hoists static imports above module-body
 * statements, so this must be called at MODULE SCOPE, before any dynamic
 * `await import()` of db-dependent modules — DATABASE_PATH is assigned here,
 * and ./db resolves it when its module body first runs. The first test in
 * each DB suite should still pin the connection to the returned dbPath
 * (`(db.$client as { name: string }).name`), so an accidental static import
 * of ./db fails loudly instead of seeding the developer's real database.
 *
 * Schema creation shells out to the repo's own migrator
 * (`node scripts/migrate.mjs`) in a subprocess — the production CLI path,
 * in a clean process with no cached modules. Registers an afterAll that
 * removes the temp dir (best effort: Windows keeps WAL siblings open).
 */

export interface TempDb {
  /** the migrated SQLite file; also assigned to process.env.DATABASE_PATH */
  dbPath: string;
  /** owning temp dir — tests that create sibling files (backups, extra DBs) use this */
  tmpDir: string;
}

export function setupMigratedTempDb(prefix: string): TempDb {
  process.env.APP_SECRET ??= `${prefix}-test-secret-0123456789`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-${prefix}-`));
  const dbPath = path.join(tmpDir, "test.db");
  process.env.DATABASE_PATH = dbPath;
  fs.writeFileSync(dbPath, "");
  const repoRoot = process.cwd();
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "migrate.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: "pipe",
    timeout: 120_000,
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* WAL held open on Windows */
    }
  });
  return { dbPath, tmpDir };
}
