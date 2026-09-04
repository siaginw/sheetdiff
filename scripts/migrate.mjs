// CLI: stamp legacy (push-created) DBs, then apply committed migrations.
// Mirrors src/lib/db/migrate.ts in plain JS because the boot path handles
// this automatically — this script exists for manual/pipeline use.
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "sheetdiff.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const folder = path.join(process.cwd(), "drizzle");
if (!fs.existsSync(path.join(folder, "meta", "_journal.json"))) {
  console.log("[migrate] no migrations folder — nothing to do");
  process.exit(0);
}

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 30000"); // two containers on one volume: wait, don't crash-loop
const hasUsers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
const journalHashes = journal.entries.map((e) => {
  const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
  return { tag: e.tag, when: e.when, hash: crypto.createHash("sha256").update(sqlText).digest("hex") };
});
sqlite.exec(
  "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
);
// applied ROW count, not table existence — an empty table (legacy DB, or a
// prior run that crashed between CREATE and stamping) still needs stamping
const appliedHashes = new Set(
  sqlite
    .prepare("SELECT hash FROM __drizzle_migrations")
    .all()
    .map((r) => r.hash),
);

// pre-migration backup, same rule as the boot path (src/lib/db/migrate.ts):
// only when a journal entry isn't recorded yet — count (legacy/new) or hash
// (re-authored). The CLI does the same destructive work as boot; it gets the
// same safety net.
const journalHashSet = new Set(journalHashes.map((j) => j.hash));
if (appliedHashes.size > 0 && [...appliedHashes].some((h) => !journalHashSet.has(h))) {
  console.warn(
    "[migrate] recorded migration hashes diverge from drizzle/meta (re-authored migrations?) — never hand-edit committed migrations; see CONTRIBUTING",
  );
}
if (hasUsers && journalHashes.some((j) => !appliedHashes.has(j.hash))) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(dbPath, path.join(backupDir, `pre-migrate-${Date.now()}.db`));
  console.log("[migrate] pre-migration backup written");
}

if (hasUsers && appliedHashes.size === 0) {
  // CRITICAL: stamp only entries already reflected in the schema — a v0.2 DB
  // lacks 0001's columns; stamping it would skip the ALTERs and crash every
  // new-column read. Mirror of src/lib/db/migrate.ts.
  const columnExists = (table, col) => {
    try {
      sqlite.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  };
  const markers = {
    "0000_equal_darkstar": { table: "change_acks", col: "row_key" },
    "0001_glorious_infant_terrible": { table: "spreadsheets", col: "capture_fail_streak" },
  };
  const already = journal.entries.filter((e) => {
    const mk = markers[e.tag];
    if (!mk) return false;
    const h = journalHashes.find((x) => x.tag === e.tag);
    return mk && columnExists(mk.table, mk.col) && h;
  });
  const ins = sqlite.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)');
  for (const e of already) {
    const h = journalHashes.find((x) => x.tag === e.tag);
    if (h) ins.run(h.hash, e.when);
  }
  console.log(
    `[migrate] stamped ${already.length}/${journal.entries.length} migration(s) in the legacy schema — the rest apply normally`,
  );
}

// apply POSITIONALLY, like drizzle's boot-path migrator: entries beyond the
// recorded row count run; a re-authored entry WITHIN the recorded range is a
// no-op on boot, and the CLI used to crash on it instead (CREATE TABLE on an
// existing table) — the divergence warning above already told the operator why
const appliedCount = sqlite.prepare("SELECT count(*) c FROM __drizzle_migrations").get().c;
let ran = 0;
for (let i = appliedCount; i < journal.entries.length; i++) {
  const e = journal.entries[i];
  const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
  const hash = crypto.createHash("sha256").update(sqlText).digest("hex");
  sqlite.exec(sqlText.split("--> statement-breakpoint").join(""));
  sqlite.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)').run(hash, e.when);
  ran++;
}
sqlite.close();
console.log(`[migrate] done (${ran} applied, ${appliedCount} already recorded)`);
