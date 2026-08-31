/**
 * Migration self-heal + backup gate, executed against real fixtures and the
 * repo's real committed journal — the paths fleet-6 fixed by hand after the
 * CLI's duplicate CREATE TABLE bricked legacy DBs. A regression here is a
 * boot crash loop on `docker compose up` for every legacy user.
 *
 * Both paths run against their own temp DBs (never the real data/):
 *  - boot: ensureMigrated() with DATABASE_PATH swapped per fixture
 *  - CLI: `node scripts/migrate.mjs` via execFileSync
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "migrate-test-secret-0123456789";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sd-migrate-"));
const repoRoot = process.cwd();
const journalPath = path.join(repoRoot, "drizzle", "meta", "_journal.json");
const journalCount = (JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: unknown[] }).entries.length;

/** A v0.2-era push-created DB: users table, no __drizzle_migrations. */
function legacyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${name}-`)); // own dir → own backups/
  const dbPath = path.join(dir, `${name}.db`);
  const db = new Database(dbPath);
  // a v0.2 push-created DB carries the full 0000-era schema (drizzle-kit push
  // materializes every table), NOT a bare users table
  const sql0000 = fs.readFileSync(path.join(repoRoot, "drizzle", "0000_equal_darkstar.sql"), "utf8");
  db.exec(sql0000.split("--> statement-breakpoint").join(""));
  db.prepare("INSERT INTO users (id, google_sub, email, name, tokens_enc, created_at) VALUES ('legacy-1', 'sub-x', 'legacy@x.com', 'L', 't', 1)").run();
  db.close();
  return dbPath;
}

/** The residue of the old CLI bug: users + an EMPTY migrations table. */
function brickedFixture(name: string): string {
  const dbPath = legacyFixture(name);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
  db.close();
  return dbPath;
}

function stateOf(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      applied: (db.prepare("SELECT count(*) c FROM __drizzle_migrations").get() as { c: number }).c,
      users: (db.prepare("SELECT count(*) c FROM users").get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

const backupsIn = (dbPath: string) =>
  fs.existsSync(path.join(path.dirname(dbPath), "backups"))
    ? fs.readdirSync(path.join(path.dirname(dbPath), "backups")).filter((f) => f.startsWith("pre-migrate-"))
    : [];

/** Run the boot path against one fixture (fresh module per state). */
async function bootMigrate(dbPath: string) {
  process.env.DATABASE_PATH = dbPath;
  const { ensureMigrated } = await import("./migrate");
  ensureMigrated();
}

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows WAL */ }
});

describe("ensureMigrated (boot path)", () => {
  it("stamps a legacy push-created DB without crashing, preserving users, with a backup", async () => {
    const dbPath = legacyFixture("boot-legacy.db");
    await bootMigrate(dbPath);
    expect(stateOf(dbPath)).toEqual({ applied: journalCount, users: 1 });
    expect(backupsIn(dbPath).length).toBe(1);
  });

  it("self-heals a bricked empty-migrations-table DB (the old CLI bug's residue)", async () => {
    const dbPath = brickedFixture("boot-bricked.db");
    await bootMigrate(dbPath);
    expect(stateOf(dbPath)).toEqual({ applied: journalCount, users: 1 });
  });

  it("is idempotent on a healthy DB: no re-stamp, no unbounded backups", async () => {
    const dbPath = legacyFixture("boot-twice.db");
    await bootMigrate(dbPath);
    await bootMigrate(dbPath);
    await bootMigrate(dbPath);
    expect(stateOf(dbPath).applied).toBe(journalCount);
    expect(backupsIn(dbPath).length).toBe(1); // work was pending exactly once
  });
});

describe("scripts/migrate.mjs (CLI path)", () => {
  const cliMigrate = (dbPath: string) =>
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "migrate.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: "pipe",
      timeout: 60_000,
    }).toString();

  it("stamps a legacy DB without the old 'table already exists' crash, WITH a backup", () => {
    const dbPath = legacyFixture("cli-legacy.db");
    const out = cliMigrate(dbPath);
    expect(out).toContain("stamped");
    expect(stateOf(dbPath)).toEqual({ applied: journalCount, users: 1 });
    expect(backupsIn(dbPath).length).toBe(1); // the CLI now has the same safety net as boot
  });

  it("self-heals the bricked fixture and is idempotent on re-run", () => {
    const dbPath = brickedFixture("cli-bricked.db");
    cliMigrate(dbPath);
    const out2 = cliMigrate(dbPath);
    expect(out2).toContain("already recorded");
    expect(stateOf(dbPath)).toEqual({ applied: journalCount, users: 1 });
    expect(backupsIn(dbPath).length).toBe(1);
  });
});

describe("hash-divergent journal (re-authored migrations)", () => {
  const run = (dbPath: string) => {
    // console.warn goes to stderr — merge both streams for assertion
    const r = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "migrate.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_PATH: dbPath },
      timeout: 60_000,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return (r.stdout ?? "") + (r.stderr ?? "");
  };

  it("CLI warns, backs up, and NO-OPS instead of crashing (boot-path parity)", () => {
    const dbPath = legacyFixture("cli-divergent.db");
    run(dbPath); // stamp + apply
    expect(stateOf(dbPath)).toEqual({ applied: journalCount, users: 1 });
    expect(backupsIn(dbPath).length).toBe(1);

    // re-author the recorded hash in place (same count, different hash)
    const db = new Database(dbPath);
    db.prepare("UPDATE __drizzle_migrations SET hash = ?").run("0".repeat(64));
    db.close();

    const out = run(dbPath);
    expect(out).toContain("diverge from drizzle/meta"); // loud warning
    expect(out).toContain("already recorded"); // no re-execution, no crash
    expect(stateOf(dbPath)).toEqual({ applied: journalCount, users: 1 }); // data intact
    expect(backupsIn(dbPath).length).toBe(2); // safety net fired again
  });
});

describe("legacy v0.2 upgrade with 0001 present (fleet-13 blocker)", () => {
  it("applies 0001's columns on a v0.2 DB — the stamp must not skip them", async () => {
    const dbPath = legacyFixture("v2-upgrade.db");
    await bootMigrate(dbPath);
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(spreadsheets)").all().map((c) => (c as { name: string }).name);
      expect(cols).toContain("capture_fail_streak");
      expect(cols).toContain("last_capture_error");
      expect(cols).toContain("last_capture_error_at");
      const applied = (db.prepare("SELECT count(*) c FROM __drizzle_migrations").get() as { c: number }).c;
      expect(applied).toBe(journalCount);
      expect((db.prepare("SELECT count(*) c FROM users").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });
});
