import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
    const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    // hash each journal entry's SQL once — used by the backup gate AND stamping
    const journalEntries = journal.entries.map((e) => {
      const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
      return { tag: e.tag, when: e.when, hash: crypto.createHash("sha256").update(sqlText).digest("hex"), sqlText };
    });
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    // applied ROW count, not table existence — an empty table (legacy DB, or a
    // prior run that crashed between CREATE and stamping) still needs stamping
    const appliedHashes = new Set(
      (sqlite.prepare("SELECT hash FROM __drizzle_migrations").all() as { hash: string }[]).map((r) => r.hash),
    );
    const hasUsers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();

    // pre-migration backup: only when actual migration work may run — a
    // journal entry the DB hasn't recorded, whether by count (legacy DB, new
    // migration) or by hash (a migration file re-authored in place). Not every
    // boot, which would grow without bound.
    const journalSet = new Set(journalEntries.map((j) => j.hash));
    // any recorded hash absent from the journal means migrations were
    // re-authored in place — warn regardless of count (fleet-10: the
    // count-equal-only condition missed the more-entries-than-applied shape)
    if (appliedHashes.size > 0 && [...appliedHashes].some((h) => !journalSet.has(h))) {
      console.warn(
        "[migrate] recorded migration hashes diverge from drizzle/meta (re-authored migrations?) — never hand-edit committed migrations; see CONTRIBUTING",
      );
    }
    for (const j of journalEntries) {
      // drizzle's splitter keeps an empty tail chunk from a trailing
      // statement-breakpoint and FAILS THE BOOT with a cryptic query error —
      // reject the malformed file loudly at the door instead
      if (j.sqlText.trimEnd().endsWith("--> statement-breakpoint")) {
        throw new Error(
          `[migrate] ${j.tag}.sql ends with a bare statement-breakpoint — remove it (boot splits strictly and fails on the empty tail)`,
        );
      }
    }
    const pendingWork = journalEntries.some((j) => !appliedHashes.has(j.hash));
    if (hasUsers && pendingWork) {
      const backupDir = path.join(path.dirname(dbPath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      fs.copyFileSync(dbPath, path.join(backupDir, `pre-migrate-${Date.now()}.db`));
    }

    if (hasUsers && appliedHashes.size === 0) {
      // Legacy push-created DB (or self-heal of an empty migrations table).
      // CRITICAL: stamp only the entries ALREADY REFLECTED IN THE SCHEMA — a
      // v0.2 DB has 0000's tables but NOT 0001's columns; stamping 0001 too
      // would skip its ALTERs and every new-column read would crash ("no such
      // column"). The marker: does the LAST column added by each migration
      // exist? We check the newest table the migration introduces.
      const columnExists = (table: string, col: string): boolean => {
        try {
          sqlite.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get();
          return true;
        } catch {
          return false;
        }
      };
      // what each migration's presence looks like in the schema
      const migrationMarkers: Record<string, { table: string; col: string }> = {
        "0000_equal_darkstar": { table: "change_acks", col: "row_key" },
        "0001_glorious_infant_terrible": { table: "spreadsheets", col: "capture_fail_streak" },
      };
      const alreadyApplied = journalEntries.filter((e) => {
        const marker = migrationMarkers[e.tag];
        if (!marker) return false; // unknown migration: never stamp, let it run
        return columnExists(marker.table, marker.col);
      });
      const ins = sqlite.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)');
      for (const e of alreadyApplied) {
        ins.run(e.hash, e.when);
      }
      console.log(
        `[migrate] stamped ${alreadyApplied.length}/${journalEntries.length} migration(s) already reflected in the legacy schema — the rest will apply normally`,
      );
    }

    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}
