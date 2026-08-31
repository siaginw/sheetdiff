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
    const journal = JSON.parse(
      fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string; when: number }[] };
    // hash each journal entry's SQL once — used by the backup gate AND stamping
    const journalEntries = journal.entries.map((e) => {
      const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
      return { when: e.when, hash: crypto.createHash("sha256").update(sqlText).digest("hex") };
    });
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    // applied ROW count, not table existence — an empty table (legacy DB, or a
    // prior run that crashed between CREATE and stamping) still needs stamping
    const appliedHashes = new Set(
      (sqlite.prepare("SELECT hash FROM __drizzle_migrations").all() as { hash: string }[]).map(
        (r) => r.hash,
      ),
    );
    const hasUsers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();

    // pre-migration backup: only when actual migration work may run — a
    // journal entry the DB hasn't recorded, whether by count (legacy DB, new
    // migration) or by hash (a migration file re-authored in place). Not every
    // boot, which would grow without bound.
    const pendingWork = journalEntries.some((j) => !appliedHashes.has(j.hash));
    if (pendingWork && journalEntries.length === appliedHashes.size) {
      // same count, different hashes: migrations were re-authored in place.
      // drizzle's timestamp-driven apply() usually no-ops, so the only visible
      // effect is a pre-migrate backup on every boot — say so, loudly.
      console.warn("[migrate] recorded migration hashes diverge from drizzle/meta (re-authored migrations?) — never hand-edit committed migrations; see CONTRIBUTING");
    }
    if (hasUsers && pendingWork) {
      const backupDir = path.join(path.dirname(dbPath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      fs.copyFileSync(dbPath, path.join(backupDir, `pre-migrate-${Date.now()}.db`));
    }

    if (hasUsers && appliedHashes.size === 0) {
      // legacy push-created DB (or self-heal of an empty migrations table):
      // stamp every journal entry as applied
      const ins = sqlite.prepare(
        'INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)',
      );
      for (const e of journalEntries) {
        ins.run(e.hash, e.when);
      }
      console.log(`[migrate] stamped ${journalEntries.length} baseline migration(s) on legacy DB`);
    }

    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}
