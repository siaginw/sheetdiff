/**
 * Maintenance + digest-due DB tests against a temp SQLite database.
 * Same harness contract as actions.db.test.ts.
 */
import { vi } from "vitest";

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async () => {} }) },
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

process.env.APP_SECRET ??= "maintenance-test-secret-0123456789";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-maint-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
fs.writeFileSync(process.env.DATABASE_PATH, "");
const repoRoot = process.cwd();
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "migrate.mjs")], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH },
  stdio: "pipe",
  timeout: 120_000,
});

const { eq } = await import("drizzle-orm");
const { db } = await import("./db");
const { snapshots, spreadsheets, tabs, users } = await import("./db/schema");
const { encodeSnapshot, toSnapshotData } = await import("./snapshots");
const { backupDatabase, maintenanceDue, pruneSnapshots } = await import("./maintenance");
const { usersDueForDigest } = await import("./digest");

const snapBlob = (grid: string[][]) => encodeSnapshot(toSnapshotData(grid));

beforeAll(async () => {
  await db.insert(users).values({ id: "u1", googleSub: "sub-u1", email: null, name: "u1", tokensEnc: "unused", createdAt: 1 });
  await db.insert(spreadsheets).values({ id: "s1", userId: "u1", googleId: "g1", title: "T", url: "https://x", createdAt: 1 });
  await db.insert(tabs).values({ id: "t1", spreadsheetId: "s1", title: "A", position: 0, tracked: true });
  await db.insert(tabs).values({ id: "t2", spreadsheetId: "s1", title: "B", position: 1, tracked: true });

  const rows: (typeof snapshots.$inferInsert)[] = [
    { id: "snap-base", tabId: "t1", runId: "r0", trigger: "manual", isBaseline: true, rowCount: 0, colCount: 0, dataBlob: snapBlob([["h"]]), createdAt: 0 },
  ];
  for (let i = 1; i <= 6; i++) {
    rows.push({ id: `snap-${i}`, tabId: "t1", runId: `r${i}`, trigger: "manual", isBaseline: false, rowCount: 0, colCount: 0, dataBlob: snapBlob([["h"]]), createdAt: i });
  }
  for (let i = 7; i <= 12; i++) {
    rows.push({ id: `snap-${i}`, tabId: "t2", runId: `r${i}`, trigger: "manual", isBaseline: false, rowCount: 0, colCount: 0, dataBlob: snapBlob([["h"]]), createdAt: i });
  }
  await db.insert(snapshots).values(rows);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
});

const idsFor = async (tabId: string) =>
  (await db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.tabId, tabId))).map((r) => r.id).sort();

describe("temp-db harness", () => {
  it("runs against the temp database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("pruneSnapshots", () => {
  it("keeps the newest N non-baselines per tab and never prunes a baseline", async () => {
    process.env.SHEETDIFF_KEEP_SNAPSHOTS = "3";
    expect(await pruneSnapshots()).toBe(6);
    expect(await idsFor("t1")).toEqual(["snap-4", "snap-5", "snap-6", "snap-base"]);
    expect(await idsFor("t2")).toEqual(["snap-10", "snap-11", "snap-12"]);
  });

  it("never prunes below 2 non-baseline snapshots (floor)", async () => {
    process.env.SHEETDIFF_KEEP_SNAPSHOTS = "1";
    expect(await pruneSnapshots()).toBe(2);
    expect(await idsFor("t1")).toEqual(["snap-5", "snap-6", "snap-base"]);
  });

  it("keep<=0 keeps everything", async () => {
    process.env.SHEETDIFF_KEEP_SNAPSHOTS = "0";
    expect(await pruneSnapshots()).toBe(0);
  });
});

describe("backupDatabase", () => {
  it("backs up once per day (second same-day call returns the same path)", async () => {
    delete process.env.SHEETDIFF_BACKUPS;
    const dest = await backupDatabase();
    expect(dest && fs.existsSync(dest)).toBe(true);
    await db.insert(users).values({ id: "u-extra", googleSub: "sub-x", email: null, name: "x", tokensEnc: "u", createdAt: 2 });
    expect(await backupDatabase()).toBe(dest); // same-day idempotent
  });

  it("leaves no -shm/-wal sidecars behind (the verify connection's litter)", async () => {
    const dest = await backupDatabase();
    const dir = path.dirname(dest!);
    expect(fs.readdirSync(dir).some((f) => f.endsWith("-shm") || f.endsWith("-wal"))).toBe(false);
  });

  it("returns null when disabled", async () => {
    process.env.SHEETDIFF_BACKUPS = "0";
    expect(await backupDatabase()).toBeNull();
    delete process.env.SHEETDIFF_BACKUPS;
  });

  it("evicts oldest-first by REAL timestamp: pre-migrate backups survive their day, oldest dailies go first", async () => {
    // fixture: rename today's backup to 2000-01-01 (genuinely oldest), add 8
    // old dailies and a RECENT pre-migrate file, keep=3. Newest 3 survive
    // (recent pre-migrate + today + the newest daily); the rest evict,
    // oldest-first, capped at 20 per sweep.
    const dir = path.join(path.dirname(process.env.DATABASE_PATH!), "backups");
    for (let i = 1; i <= 8; i++) {
      const d = new Date(Date.now() - (i + 2) * 86_400_000).toISOString().slice(0, 10);
      fs.writeFileSync(path.join(dir, `sheetdiff-${d}.db`), "old");
    }
    const recentPre = `pre-migrate-${Date.now() - 3_600_000}.db`;
    fs.writeFileSync(path.join(dir, recentPre), "recent");
    process.env.SHEETDIFF_BACKUPS = "3";
    fs.renameSync(
      path.join(dir, path.basename((await backupDatabase())!)),
      path.join(dir, "sheetdiff-2000-01-01.db"),
    );
    await backupDatabase(); // creates today's + evicts down to keep=3
    const left = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
    // the recent pre-migrate survives — it is NEWER than every old daily, so
    // "alphabetical pre-migrate first out" is dead
    expect(left).toContain(recentPre);
    // newest 3 by real timestamp survive: recentPre, today, newest daily
    expect(left).toHaveLength(3);
    expect(left.filter((f) => f.startsWith("sheetdiff-")).length).toBe(2); // today + newest daily
    expect(left).not.toContain("sheetdiff-2000-01-01.db"); // genuinely oldest — evicted first
    delete process.env.SHEETDIFF_BACKUPS;
  });
});

describe("maintenanceDue", () => {
  it("is due after 3am, once per day, not before 3am", () => {
    expect(maintenanceDue(new Date(2026, 7, 30, 3, 0))).toBe(true);
    expect(maintenanceDue(new Date(2026, 7, 30, 4, 0))).toBe(false);
    expect(maintenanceDue(new Date(2026, 7, 30, 1, 0))).toBe(false);
    expect(maintenanceDue(new Date(2026, 7, 31, 3, 0))).toBe(true);
  });
});

describe("usersDueForDigest", () => {
  it("selects exactly the users whose digest is due right now", async () => {
    const now = new Date(2026, 7, 30, 7, 30).getTime();
    const seed = [
      { id: "d-due", digestEmail: "due@x.com", digestTime: "07:00", digestDay: null, lastDigestAt: now - 24 * 3_600_000 },
      { id: "d-sent", digestEmail: "s@x.com", digestTime: "07:00", digestDay: null, lastDigestAt: new Date(2026, 7, 30, 6, 0).getTime() },
      { id: "d-early", digestEmail: "e@x.com", digestTime: "09:00", digestDay: null, lastDigestAt: 0 },
      { id: "d-weekly", digestEmail: "w@x.com", digestTime: "07:00", digestDay: new Date(now).getDay(), lastDigestAt: now - 7 * 24 * 3_600_000 },
      { id: "d-wrongday", digestEmail: "wd@x.com", digestTime: "07:00", digestDay: (new Date(now).getDay() + 1) % 7, lastDigestAt: 0 },
      { id: "d-noemail", digestEmail: null, digestTime: "07:00", digestDay: null, lastDigestAt: 0 },
    ];
    for (const u of seed) {
      await db.insert(users).values({
        id: u.id, googleSub: `sub-${u.id}`, email: `${u.id}@x.com`, name: u.id, tokensEnc: "u",
        digestEmail: u.digestEmail, digestTime: u.digestTime, digestDay: u.digestDay, lastDigestAt: u.lastDigestAt, createdAt: 1,
      });
    }
    const due = await usersDueForDigest(now);
    expect(due.map((u) => u.id).sort()).toEqual(["d-due", "d-weekly"]);
  });
});

describe("backupDatabase local-calendar stamp", () => {
  it("names the file by LOCAL date even when the UTC date has rolled over", async () => {
    // find an instant where UTC and local dates differ (impossible only on
    // exactly UTC±0 — where the bug cannot happen either); the clock is
    // injected (backupDatabase(now)), fake timers freeze better-sqlite3's
    // async paged backup
    let t = new Date(2026, 7, 20, 12, 0, 0).getTime();
    let guard = 0;
    while (new Date(t).getUTCDate() === new Date(t).getDate() && guard++ < 48) t += 3_600_000;
    if (new Date(t).getUTCDate() === new Date(t).getDate()) return; // UTC+0 host
    const prev = process.env.DATABASE_PATH;
    const sub = path.join(tmpDir, `midnight-${guard}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(prev!, path.join(sub, "test.db"));
    process.env.DATABASE_PATH = path.join(sub, "test.db");
    try {
      const dest = await backupDatabase(new Date(t));
      const local = new Date(t);
      const p2 = (n: number) => String(n).padStart(2, "0");
      const expected = `sheetdiff-${local.getFullYear()}-${p2(local.getMonth() + 1)}-${p2(local.getDate())}.db`;
      expect(path.basename(dest!)).toBe(expected);
      expect(dest && fs.existsSync(dest)).toBe(true);
    } finally {
      process.env.DATABASE_PATH = prev;
    }
  });
});
