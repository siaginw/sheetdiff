/**
 * The ENTRY QUEUE export — one row per shot in the tab's native column
 * order, oldest introduction first. Pins the shape that makes it a typing
 * list (vs the worklist's cell-by-cell lines) and the shared-resolver
 * parity (acks drop rows here like everywhere else).
 */
import { vi } from "vitest";

const state = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const { signValue } = await import("@/lib/crypto");
    return {
      get: (name: string) =>
        name === "sd_session" && state.userId
          ? { value: signValue(state.userId, 30 * 24 * 3_600_000) }
          : undefined,
      delete: () => {},
    };
  },
}));
vi.mock("@/lib/google", () => ({
  parseSpreadsheetId: (s: string) => s.match(/[a-zA-Z0-9-_]{20,}/)?.[0] ?? null,
  fetchSpreadsheetMeta: async () => ({ title: "Scratch", tabs: [] }),
  getUserClient: async () => ({}),
  fetchTabValues: async () => ({}),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.APP_SECRET ??= "queue-route-test-secret-0123456789";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-queue-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
fs.writeFileSync(process.env.DATABASE_PATH, "");
const repoRoot = process.cwd();
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "migrate.mjs")], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH },
  stdio: "pipe",
  timeout: 120_000,
});

const { db } = await import("@/lib/db");
const { snapshots, snapshotStats, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { getPendingChanges } = await import("@/lib/pending");
const { setAck } = await import("@/lib/sync");
const { GET } = await import("./route");

const signIn = (id: string | null) => {
  state.userId = id;
};

// tab A: one added row (native 4 columns); tab B: one row with TWO changed
// cells (the row/cell divergence case — the queue must emit ONE line)
const GRID_A0 = [["Shot", "Qty", "Note"], ["s1", "40", ""]];
const GRID_A1 = [["Shot", "Qty", "Note"], ["s1", "40", ""], ["s2", "10", "new"]];
const GRID_B0 = [["ID", "Qty", "Note"], ["9", "5", "a"]];
const GRID_B1 = [["ID", "Qty", "Note"], ["9", "7", "b"]];

const trackedTabs = async () => (await db.select().from(tabs).where(eq(tabs.spreadsheetId, "sh1"))).filter((t) => t.tracked);

async function csvLines(id: string): Promise<string[]> {
  const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });
  const body = await (await res).text();
  return body.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
}

beforeAll(async () => {
  await db.insert(users).values({ id: "u1", googleSub: "s1", email: "u@x.com", name: "u1", tokensEnc: "x", createdAt: 1 });
  await db.insert(spreadsheets).values({ id: "sh1", userId: "u1", googleId: "g1", title: "Q", url: "https://x", createdAt: 1 });
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
    snapRow("sb1", "tb", "r3", false, 3000, GRID_B1), // introduced LATER than A's change
  ]);
  await db.insert(snapshotStats).values([
    { snapshotId: "sa1", tabId: "ta", added: 1, removed: 0, changed: 0, createdAt: 2000 },
    { snapshotId: "sb1", tabId: "tb", added: 0, removed: 0, changed: 1, createdAt: 3000 },
  ]);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
});

describe("entry queue export", () => {
  it("unauthorized users get nothing", async () => {
    signIn(null);
    const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "sh1" }) });
    expect(res.status).toBe(401);
  });

  it("ONE line per changed ROW (2-cell change = 1 line) in native column order; tabs ordered oldest-first", async () => {
    signIn("u1");
    const lines = await csvLines("sh1");
    // section headers for both tabs (A introduced at 2000, B at 3000 → A first)
    expect(lines[0]).toBe("Tab,Status,Changed columns,Shot,Qty,Note");
    const dataA = lines[1];
    expect(dataA.startsWith("A,NEW,,s2,10,new")).toBe(true); // full native row
    expect(lines[2]).toBe("Tab,Status,Changed columns,ID,Qty,Note");
    const dataB = lines[3];
    expect(dataB.startsWith("B,CHANGED,Qty|Note,9,7,b")).toBe(true); // ONE line, changed cols marked
    expect(dataB.split(",")).toHaveLength(6); // not 7 — no per-cell split
    // untracked tab never appears
    expect(lines.some((l) => l.startsWith("C,"))).toBe(false);
  });

  it("an ack removes its row from the queue like every other surface", async () => {
    const tabA = (await trackedTabs()).find((t) => t.title === "A")!;
    const p = await getPendingChanges(tabA);
    const added = p!.unresolved.find((r) => r.status === "added")!;
    await setAck(tabA.id, added.rowKey, true);
    const lines = await csvLines("sh1");
    expect(lines.some((l) => l.startsWith("A,NEW,,s2"))).toBe(false);
    expect(lines.some((l) => l.startsWith("B,CHANGED"))).toBe(true); // B unaffected
    await setAck(tabA.id, added.rowKey, false);
  });

  it("removed rows are summary-only (nothing to re-key)", async () => {
    // add a removal on tab A: drop the s1 row
    const data = toSnapshotData([["Shot", "Qty", "Note"], ["s2", "10", "new"]]);
    await db.insert(snapshots).values({
      id: "sa2", tabId: "ta", runId: "r4", trigger: "manual", isBaseline: false,
      rowCount: data.rows.length, colCount: data.headers.length,
      dataBlob: encodeSnapshot(data), createdAt: 4000,
    });
    await db.insert(snapshotStats).values({ snapshotId: "sa2", tabId: "ta", added: 0, removed: 1, changed: 0, createdAt: 4000 });
    const lines = await csvLines("sh1");
    const removed = lines.find((l) => l.startsWith("A,REMOVED"));
    expect(removed).toBeDefined();
    expect(removed!).toContain("DELETE DOWNSTREAM: s1 | 40");
  });
});
