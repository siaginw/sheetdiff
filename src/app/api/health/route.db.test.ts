/**
 * /api/health — the Docker HEALTHCHECK's only scheduler-failure signal: a
 * non-zero staleCaptures must be visible while pages still render fine from
 * old data. DB harness, standard temp DATABASE_PATH pattern.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "health-test-secret-0123456789";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-health-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
fs.writeFileSync(process.env.DATABASE_PATH, "");
const repoRoot = process.cwd();
const drizzleKit = path.join(repoRoot, "node_modules", "drizzle-kit", "bin.cjs");
execFileSync(process.execPath, [drizzleKit, "push", "--force"], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH },
  stdio: "pipe",
  timeout: 120_000,
});

const { db } = await import("@/lib/db");
const { spreadsheets, users } = await import("@/lib/db/schema");
const { GET } = await import("./route");

const DAY = 86_400_000;
const NOW = Date.now();

beforeAll(async () => {
  await db.insert(users).values({ id: "u1", googleSub: "s1", email: "u@x.com", name: "u1", tokensEnc: "x", createdAt: 1 });
  const sheet = (id: string, kind: "hourly" | "daily" | "off", last: number | null) =>
    db.insert(spreadsheets).values({
      id, userId: "u1", googleId: id, title: id, url: "https://x", createdAt: 1,
      scheduleKind: kind, scheduleHours: kind === "hourly" ? 1 : null, lastSnapshotAt: last,
    });
  await sheet("h-stale", "hourly", NOW - 5 * DAY); // dead 5 days — 3h window blown
  await sheet("h-fresh", "hourly", NOW - 3_600_000); // fine
  await sheet("d-stale", "daily", NOW - 3 * DAY); // 48h window blown
  await sheet("d-fresh", "daily", NOW - DAY);
  await sheet("paused-old", "off", NOW - 30 * DAY); // paused forever — exempt by choice
  await sheet("never", "daily", null); // never captured — nothing to be stale about
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
});

describe("GET /api/health", () => {
  it("counts exactly the overdue scheduled sheets; paused and never-captured are exempt", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
    expect(body.staleCaptures).toBe(2); // h-stale + d-stale
  });
});
