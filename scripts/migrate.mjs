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
  return { when: e.when, hash: crypto.createHash("sha256").update(sqlText).digest("hex") };
});
sqlite.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
// applied ROW count, not table existence — an empty table (legacy DB, or a
// prior run that crashed between CREATE and stamping) still needs stamping
const appliedHashes = new Set(sqlite.prepare("SELECT hash FROM __drizzle_migrations").all().map((r) => r.hash));

// pre-migration backup, same rule as the boot path (src/lib/db/migrate.ts):
// only when a journal entry isn't recorded yet — count (legacy/new) or hash
// (re-authored). The CLI does the same destructive work as boot; it gets the
// same safety net.
if (hasUsers && journalHashes.some((j) => !appliedHashes.has(j.hash))) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(dbPath, path.join(backupDir, `pre-migrate-${Date.now()}.db`));
  console.log("[migrate] pre-migration backup written");
}

if (hasUsers && appliedHashes.size === 0) {
  const ins = sqlite.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)');
  for (const j of journalHashes) {
    ins.run(j.hash, j.when);
  }
  console.log(`[migrate] stamped ${journalHashes.length} baseline migration(s) on legacy DB`);
}

// apply pending migrations by executing journal entries not yet recorded
const applied = new Set(sqlite.prepare("SELECT hash FROM __drizzle_migrations").all().map((r) => r.hash));
let ran = 0;
for (const e of journal.entries) {
  const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
  const hash = crypto.createHash("sha256").update(sqlText).digest("hex");
  if (applied.has(hash)) continue;
  sqlite.exec(sqlText.split("--> statement-breakpoint").join(""));
  sqlite.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)').run(hash, e.when);
  ran++;
}
sqlite.close();
console.log(`[migrate] done (${ran} applied, ${applied.size} already recorded)`);
