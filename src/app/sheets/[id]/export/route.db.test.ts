/**
 * DB tests for the to-enter worklist export — pinning the fleet-6/7 invariant
 * that "Mark as collected (N to enter)" can never disagree with the export:
 * both come from the same per-tab getPendingChanges loop. The units differ by
 * design (the button counts ROWS, the CSV emits one line per changed CELL plus
 * one per added/removed row), so this test pins BOTH formulas and the parity
 * between the route and a direct resolver read.
 *
 * Same harness contract as the billing route tests: temp DATABASE_PATH set
 * before any db-dependent import, signed session cookie, real access/pending
 * stack, "@/lib/google" mocked.
 */
import { vi } from "vitest";

const state = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const { signValue } = await import("@/lib/crypto");
    return {
      get: (name: string) =>
        name === "sd_session" && state.userId ? { value: signValue(state.userId, 30 * 24 * 3_600_000) } : undefined,
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

import { setupMigratedTempDb } from "@/test/db-harness";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

setupMigratedTempDb("worklist");

const { db } = await import("@/lib/db");
const { snapshots, snapshotStats, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { getPendingChanges } = await import("@/lib/pending");
const { setAck } = await import("@/lib/sync");
const { GET } = await import("./route");

const signIn = (id: string | null) => {
  state.userId = id;
};

// tabs keyed on col 0; tab B changes a row with TWO cells (the row/cell unit
// divergence case), tab A adds one row; tab C is UNTRACKED and must never show
const GRID_A0 = [
  ["ID", "Qty", "Note"],
  ["1", "40", ""],
];
const GRID_A1 = [
  ["ID", "Qty", "Note"],
  ["1", "40", ""],
  ["2", "10", "new"],
];
const GRID_B0 = [
  ["ID", "Qty", "Note"],
  ["9", "5", "a"],
];
const GRID_B1 = [
  ["ID", "Qty", "Note"],
  ["9", "7", "b"],
];

const trackedTabs = async () =>
  (await db.select().from(tabs).where(eq(tabs.spreadsheetId, "sh1"))).filter((t) => t.tracked);

/** What "Mark as collected (N to enter)" renders: the per-tab unresolved sum. */
async function buttonRowCount(): Promise<number> {
  let n = 0;
  for (const t of await trackedTabs()) {
    const p = await getPendingChanges(t);
    if (p) n += p.counts.unresolved;
  }
  return n;
}

/** What the CSV must emit: changed cells + one line per added/removed row. */
async function expectedCsvLineCount(): Promise<number> {
  let n = 0;
  for (const t of await trackedTabs()) {
    const p = await getPendingChanges(t);
    if (!p) continue;
    for (const row of p.unresolved) n += row.status === "changed" ? row.cells.length : 1;
  }
  return n;
}

beforeAll(async () => {
  await db
    .insert(users)
    .values({ id: "u1", googleSub: "s1", email: "u@x.com", name: "u1", tokensEnc: "x", createdAt: 1 });
  await db.insert(spreadsheets).values({
    id: "sh1",
    userId: "u1",
    googleId: "g1",
    title: "W",
    url: "https://x",
    createdAt: 1,
  });
  await db
    .insert(tabs)
    .values({ id: "ta", spreadsheetId: "sh1", title: "A", position: 0, tracked: true, keyColumn: 0 });
  await db
    .insert(tabs)
    .values({ id: "tb", spreadsheetId: "sh1", title: "B", position: 1, tracked: true, keyColumn: 0 });
  await db
    .insert(tabs)
    .values({ id: "tc", spreadsheetId: "sh1", title: "C", position: 2, tracked: false, keyColumn: 0 });
  const snap = (id: string, tabId: string, runId: string, baseline: boolean, at: number, grid: string[][]) => {
    const data = toSnapshotData(grid);
    return {
      id,
      tabId,
      runId,
      trigger: "manual" as const,
      isBaseline: baseline,
      rowCount: data.rows.length,
      colCount: data.headers.length,
      dataBlob: encodeSnapshot(data),
      createdAt: at,
    };
  };
  await db.insert(snapshots).values([
    snap("sa0", "ta", "r1", true, 1000, GRID_A0),
    snap("sa1", "ta", "r2", false, 2000, GRID_A1),
    snap("sb0", "tb", "r1", true, 1000, GRID_B0),
    snap("sb1", "tb", "r2", false, 2000, GRID_B1),
    // untracked tab C changes too — must never appear
    snap("sc0", "tc", "r1", true, 1000, GRID_B0),
    snap("sc1", "tc", "r2", false, 2000, GRID_B1),
  ]);
  // stats for the quiet-day coverage guard (non-zero so the full path runs)
  await db.insert(snapshotStats).values([
    { snapshotId: "sa1", tabId: "ta", added: 1, removed: 0, changed: 0, createdAt: 2000 },
    { snapshotId: "sb1", tabId: "tb", added: 0, removed: 0, changed: 1, createdAt: 2000 },
  ]);
});

async function csvDataLines(id: string): Promise<string[]> {
  const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });
  const body = await (await res).text();
  return body.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
}

describe("to-enter worklist export", () => {
  it("unauthorized users get nothing", async () => {
    signIn(null);
    const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "sh1" }) });
    expect(res.status).toBe(401);
  });

  it("one line per changed CELL (a 2-cell change = 2 lines), one per add/remove; untracked tabs never contribute", async () => {
    signIn("u1");
    const lines = await csvDataLines("sh1");
    expect(lines[0]).toBe("Tab,Change,Row ID,Row,Column,Old,New,Note,Seen at");
    const data = lines.slice(1);
    expect(data.filter((l) => l.startsWith("B,Changed")).length).toBe(2);
    expect(data.filter((l) => l.startsWith("A,Added")).length).toBe(1);
    expect(data.length).toBe(3);
    expect(data.some((l) => l.startsWith("C,"))).toBe(false);
  });

  it("PARITY: the button's row count and the CSV's line count both match the shared resolver", async () => {
    // what "Mark as collected (N to enter)" shows
    expect(await buttonRowCount()).toBe(2); // tab A's added row + tab B's changed row
    // what the CSV emits
    expect(await expectedCsvLineCount()).toBe(3);
    expect((await csvDataLines("sh1")).slice(1)).toHaveLength(3);
  });

  it("an ack removes its row from BOTH the button count and the CSV", async () => {
    const tabA = (await trackedTabs()).find((t) => t.title === "A")!;
    const pending = await getPendingChanges(tabA);
    const addedRow = pending!.unresolved.find((r) => r.status === "added")!;
    await setAck(tabA.id, addedRow.rowKey, true);

    expect(await buttonRowCount()).toBe(1); // only tab B's changed row remains
    const data = (await csvDataLines("sh1")).slice(1);
    expect(data.filter((l) => l.startsWith("A,"))).toHaveLength(0);
    expect(data).toHaveLength(2); // tab B's two cell lines

    await setAck(tabA.id, addedRow.rowKey, false); // restore
  });
});
