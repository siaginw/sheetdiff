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
const hasUsers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
const hasMigrations = sqlite.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get();

if (hasUsers && hasMigrations.c === 0) {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
  sqlite.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const ins = sqlite.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)');
  for (const e of journal.entries) {
    const sqlText = fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
    ins.run(crypto.createHash("sha256").update(sqlText).digest("hex"), e.when);
  }
  console.log(`[migrate] stamped ${journal.entries.length} baseline migration(s) on legacy DB`);
}

// apply pending migrations by executing journal entries not yet recorded
const applied = new Set(sqlite.prepare("SELECT hash FROM __drizzle_migrations").all().map((r) => r.hash));
const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
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
