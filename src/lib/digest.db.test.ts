/**
 * Digest parity + subject priority — the third surface of the product's core
 * promise (badge = CSV = billing = DIGEST, all from one resolver), plus the
 * subject rules (staleness outranks the count). DB test per the audit's
 * proposal: no real tracker file, standard temp-DATABASE_PATH harness.
 */
import { vi } from "vitest";

const sent: { subject?: string; to?: string }[] = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (opts: { subject?: string; to?: string }) => {
        sent.push({ subject: opts.subject, to: opts.to });
      },
    }),
  },
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.APP_SECRET ??= "digest-test-secret-0123456789";
process.env.SMTP_HOST ??= "smtp.test";
process.env.SMTP_USER ??= "user";
process.env.SMTP_PASS ??= "pass";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-digest-"));
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

const { db } = await import("./db");
const { snapshots, snapshotStats, spreadsheets, tabs, users } = await import("./db/schema");
const { encodeSnapshot, toSnapshotData } = await import("./snapshots");
const { getPendingChanges } = await import("./pending");
const { setAck } = await import("./sync");
const { buildDigestSheets, sendDigestTo } = await import("./digest");

const NOW = new Date("2026-08-30T12:00:00").getTime();
const GRID_A0 = [["ID", "Qty"], ["1", "40"]];
const GRID_A1 = [["ID", "Qty"], ["1", "40"], ["2", "10"]]; // added row
const GRID_B0 = [["ID", "Qty"], ["9", "5"]];
const GRID_B1 = [["ID", "Qty"], ["9", "7"]]; // changed row

const trackedTabs = async () => (await db.select().from(tabs).where(eq(tabs.spreadsheetId, "sh1"))).filter((t) => t.tracked);

beforeAll(async () => {
  await db.insert(users).values({
    id: "u1", googleSub: "s1", email: "u@x.com", name: "u1", tokensEnc: "x",
    digestEmail: "me@x.com", digestTime: "07:00", digestDay: null, createdAt: 1,
  });
  await db.insert(spreadsheets).values({
    id: "sh1", userId: "u1", googleId: "g1", title: "Digest Sheet", url: "https://x",
    createdAt: 1, scheduleKind: "daily", lastSnapshotAt: NOW - 3_600_000,
  });
  await db.insert(tabs).values({ id: "ta", spreadsheetId: "sh1", title: "A", position: 0, tracked: true, keyColumn: 0 });
  await db.insert(tabs).values({ id: "tb", spreadsheetId: "sh1", title: "B", position: 1, tracked: true, keyColumn: 0 });
  await db.insert(tabs).values({ id: "tc", spreadsheetId: "sh1", title: "C", position: 2, tracked: false, keyColumn: 0 });
  const snapRow = (id: string, tabId: string, runId: string, baseline: boolean, at: number, grid: string[][]) => {
    const data = toSnapshotData(grid);
    return {
      id, tabId, runId, trigger: "manual" as const, isBaseline: baseline,
      rowCount: data.rows.length, colCount: data.headers.length,
      dataBlob: encodeSnapshot(data), createdAt: at,
    };
  };
  await db.insert(snapshots).values([
    snapRow("sa0", "ta", "r1", true, 1000, GRID_A0),
    snapRow("sa1", "ta", "r2", false, 2000, GRID_A1),
    snapRow("sb0", "tb", "r1", true, 1000, GRID_B0),
    snapRow("sb1", "tb", "r2", false, 2000, GRID_B1),
  ]);
  await db.insert(snapshotStats).values([
    { snapshotId: "sa1", tabId: "ta", added: 1, removed: 0, changed: 0, createdAt: 2000 },
    { snapshotId: "sb1", tabId: "tb", added: 0, removed: 0, changed: 1, createdAt: 2000 },
  ]);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
});

const resolverRows = async () => {
  let n = 0;
  for (const t of await trackedTabs()) {
    const p = await getPendingChanges(t);
    if (p) n += p.counts.unresolved;
  }
  return n;
};

describe("digest parity (badge = CSV = billing = DIGEST)", () => {
  it("digest unresolved equals the shared resolver's sheet-wide count; untracked tabs contribute nothing", async () => {
    const sheets = await buildDigestSheets("u1", NOW);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.unresolved).toBe(2); // tab A's added + tab B's changed
    expect(await resolverRows()).toBe(2);
    expect(sheets[0]!.detail).toEqual({ added: 1, removed: 0, changed: 1 });
  });

  it("an ack drops the digest count exactly like every other surface", async () => {
    const tabA = (await trackedTabs()).find((t) => t.title === "A")!;
    const p = await getPendingChanges(tabA);
    const added = p!.unresolved.find((r) => r.status === "added")!;
    await setAck(tabA.id, added.rowKey, true);
    const sheets = await buildDigestSheets("u1", NOW);
    expect(sheets[0]!.unresolved).toBe(1);
    expect(await resolverRows()).toBe(1);
    await setAck(tabA.id, added.rowKey, false);
  });
});

describe("digest subject priority (staleness outranks the count)", () => {
  it("fresh + pending → count subject; stale → ⚠ leads even with pending changes", async () => {
    sent.length = 0;
    // fresh daily sheet (1h ago), pending changes exist
    const user = (await db.select().from(users).where(eq(users.id, "u1")))[0]!;
    await sendDigestTo({ ...user, lastDigestAt: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("SheetDiff: 2 changes to collect");

    // stale: lastSnapshotAt pushed past the daily 48h window
    sent.length = 0;
    await db.update(spreadsheets).set({ lastSnapshotAt: NOW - 72 * 3_600_000 }).where(eq(spreadsheets.id, "sh1"));
    await sendDigestTo({ ...user, lastDigestAt: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("SheetDiff: ⚠ 1 sheet may be stale · 2 to collect");
    // and the sheet entry itself is flagged with its age
    const sheets = await buildDigestSheets("u1", NOW);
    expect(sheets[0]!.lastSnapshotAgo).toBeTruthy();
    await db.update(spreadsheets).set({ lastSnapshotAt: NOW - 3_600_000 }).where(eq(spreadsheets.id, "sh1"));
  });
});
