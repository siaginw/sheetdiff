import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/**
 * Boot-time migrations: every server start (dev, `npm start`, Docker) applies
 * committed drizzle/ migrations before serving — so `git pull && docker
 * compose up -d --build` is the COMPLETE update procedure.
 *
 * Legacy databases created by `drizzle-kit push` (v0.2) have no
 * __drizzle_migrations table; before migrating we stamp the baseline as
 * applied so migrate() doesn't try to CREATE TABLE what already exists.
 */
export function ensureMigrated(): void {
  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "sheetdiff.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const folder = path.join(process.cwd(), "drizzle");
  if (!fs.existsSync(path.join(folder, "meta", "_journal.json"))) return; // no migrations yet

  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 30000");
    // pre-migration backup: a bad migration never costs more than the last snapshot
    const hasUsers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (hasUsers) {
      const backupDir = path.join(path.dirname(dbPath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      fs.copyFileSync(dbPath, path.join(backupDir, `pre-migrate-${Date.now()}.db`));
    }

    const hasMigrations = sqlite
      .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get() as { c: number } | undefined;

    if (hasUsers && (hasMigrations?.c ?? 0) === 0) {
      // legacy push-created DB: stamp every journal entry as applied
      const journal = JSON.parse(
        fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"),
      ) as { entries: { tag: string; when: number }[] };
      sqlite.exec(
        'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      );
      const ins = sqlite.prepare(
        'INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)',
      );
      for (const e of journal.entries) {
        const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
        ins.run(crypto.createHash("sha256").update(sqlText).digest("hex"), e.when);
      }
      console.log(`[migrate] stamped ${journal.entries.length} baseline migration(s) on legacy DB`);
    }

    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}
