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
const { getPendingChanges, hasCollectedBaseline } = await import("@/lib/pending");
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

const trackedTabs = async (sheetId = "sh1") =>
  (await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheetId))).filter((t) => t.tracked);

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

  // sh2: quiet since collection — baseline + a 0/0/0 capture after it (the
  // fully-acked quiet morning). getPendingChanges is null here, and the
  // queue must say "nothing pending", NOT "no collection point".
  await db.insert(spreadsheets).values({ id: "sh2", userId: "u1", googleId: "g2", title: "Quiet", url: "https://x", createdAt: 1 });
  await db.insert(tabs).values({ id: "tq1", spreadsheetId: "sh2", title: "Q", position: 0, tracked: true, keyColumn: 0 });
  await db.insert(snapshots).values([
    snapRow("sq0", "tq1", "rq1", true, 1000, [["K"], ["x"]]),
    snapRow("sq1", "tq1", "rq2", false, 5000, [["K"], ["x"]]),
  ]);
  await db.insert(snapshotStats).values({ snapshotId: "sq1", tabId: "tq1", added: 0, removed: 0, changed: 0, createdAt: 5000 });

  // sh3: snapshots but NO baseline anywhere — the one true "no collection point"
  await db.insert(spreadsheets).values({ id: "sh3", userId: "u1", googleId: "g3", title: "NoBase", url: "https://x", createdAt: 1 });
  await db.insert(tabs).values({ id: "tnb", spreadsheetId: "sh3", title: "N", position: 0, tracked: true, keyColumn: 0 });
  await db.insert(snapshots).values([
    snapRow("sn0", "tnb", "rn1", false, 1000, [["K"], ["x"]]),
    snapRow("sn1", "tnb", "rn2", false, 2000, [["K"], ["x"], ["y"]]),
  ]);

  // sh4: FRESH sheet, no acks — two rows introduced at different times, with
  // the LATER one sitting ABOVE the earlier one in sheet order. Oldest-first
  // must win over sheet order exactly here (no ack has ever dated anything).
  await db.insert(spreadsheets).values({ id: "sh4", userId: "u1", googleId: "g4", title: "Fresh", url: "https://x", createdAt: 1 });
  await db.insert(tabs).values({ id: "tf", spreadsheetId: "sh4", title: "F", position: 0, tracked: true, keyColumn: 0 });
  await db.insert(snapshots).values([
    snapRow("sf0", "tf", "rf1", true, 1000, [["Shot", "Qty"], ["old1", "1"]]),
    snapRow("sf1", "tf", "rf2", false, 2000, [["Shot", "Qty"], ["old1", "1"], ["old2", "2"]]),
    snapRow("sf2", "tf", "rf3", false, 3000, [["Shot", "Qty"], ["new1", "9"], ["old1", "1"], ["old2", "2"]]),
  ]);

  // tab D on sh1: a formula header — sheet-controlled text the CSV must
  // neutralize exactly like it neutralizes values
  await db.insert(tabs).values({ id: "td", spreadsheetId: "sh1", title: "D", position: 3, tracked: true, keyColumn: 0 });
  await db.insert(snapshots).values([
    snapRow("sd0", "td", "rd1", true, 1000, [['=HYPERLINK("http://evil.example";"click")', "Qty"], ["d1", "5"]]),
    snapRow("sd1", "td", "rd2", false, 5000, [['=HYPERLINK("http://evil.example";"click")', "Qty"], ["d1", "5"], ["d2", "6"]]),
  ]);
  await db.insert(snapshotStats).values({ snapshotId: "sd1", tabId: "td", added: 1, removed: 0, changed: 0, createdAt: 5000 });
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

  it("a formula HEADER is neutralized like a formula value", async () => {
    // sheet-controlled header text (=HYPERLINK / =cmd DDE class) must never
    // reach Excel as a live formula — same csvSafe rule the values get. Papa
    // quote-wraps the field (it contains quotes), so the neutralizing
    // apostrophe lands just inside the opening quote.
    const lines = await csvLines("sh1");
    const dHeader = lines.find((l) => l.startsWith("Tab,Status,Changed columns") && l.includes("HYPERLINK"));
    expect(dHeader).toBeDefined();
    expect(dHeader!.includes("\"'=HYPERLINK")).toBe(true);
    expect(dHeader!.includes("\"=HYPERLINK")).toBe(false);
  });

  it("a quiet-since-collection tab is an honest EMPTY queue, not a missing collection point", async () => {
    // the fully-acked quiet morning: getPendingChanges is null (quiet-day
    // short-circuit) but the baseline is right there
    const quiet = await getPendingChanges((await trackedTabs("sh2"))[0]!);
    expect(quiet).toBeNull();
    expect(await hasCollectedBaseline((await trackedTabs("sh2"))[0]!)).toEqual({ latestAt: 5000 });
    const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "sh2" }) });
    const body = await res.text();
    expect(body).toContain("# Nothing pending — every tracked tab is quiet since its collection point.");
    expect(body).not.toContain("No collection point");
  });

  it("a sheet with no baseline at all still gets the collection-point message", async () => {
    const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "sh3" }) });
    const body = await res.text();
    expect(body).toContain("# No collection point yet — mark a snapshot as collected first.");
  });

  it("oldest-first holds on a FRESH sheet with no acks (introduction order beats sheet order)", async () => {
    // new1 sits ABOVE old2 in the sheet, but old2 was introduced a snapshot
    // earlier — the stale backlog leads exactly when nothing has ever been acked
    const lines = await csvLines("sh4");
    const iOld = lines.findIndex((l) => l.startsWith("F,NEW,,old2"));
    const iNew = lines.findIndex((l) => l.startsWith("F,NEW,,new1"));
    expect(iOld).toBeGreaterThan(-1);
    expect(iNew).toBeGreaterThan(-1);
    expect(iOld).toBeLessThan(iNew);
  });
});
