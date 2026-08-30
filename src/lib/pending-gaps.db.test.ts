/**
 * Remaining high-value DB gaps, against a real (temp) SQLite database.
 * Same harness contract as actions.db.test.ts / maintenance.db.test.ts:
 *  - vitest hoists static imports above module-body statements, so DATABASE_PATH
 *    must be set BEFORE any ./db-dependent import — every such module is
 *    imported dynamically below, and the first test pins the connection.
 *  - next/navigation, next/cache, next/headers and ./google are mocked; the
 *    session cookie is genuinely signed+verified (crypto.ts runs for real).
 *  - ./snapshots is PARTIALLY mocked: everything stays real except
 *    captureSnapshot, which startTracking tests drive per-call. importGis and
 *    getPendingChanges are unaffected (they use toSnapshotData/encodeSnapshot/
 *    decodeSnapshot, which come through as the real implementations).
 *
 * Covers:
 *  - getPendingChanges: baseline->latest assembly, import exclusion, no-baseline
 *    null, ack resolution end-to-end (including the introduction walk), and the
 *    quiet-day stats short-circuit (proven blob-free via undecodable blobs).
 *  - importGis: xlsx sheet-name matching is case-insensitive, no-match redirects,
 *    CSV lands on the chosen tab (with first-tracked fallback).
 *  - startTracking: a failed first capture deletes the ghost sheet row.
 */
import { vi } from "vitest";
import ExcelJS from "exceljs";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  meta: { title: "Scratch", tabs: [] as { title: string }[] },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    const { signValue } = await import("./crypto");
    return {
      get: (name: string) =>
        name === "sd_session" && state.userId
          ? { value: signValue(state.userId, 30 * 24 * 3_600_000) }
          : undefined,
      delete: () => {},
    };
  },
}));
vi.mock("./google", () => ({
  parseSpreadsheetId: (s: string) => s.match(/[a-zA-Z0-9-_]{20,}/)?.[0] ?? null,
  fetchSpreadsheetMeta: async () => state.meta,
  getUserClient: async () => ({}),
  fetchTabValues: async () => ({}),
}));
vi.mock("./snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./snapshots")>();
  return { ...actual, captureSnapshot: vi.fn() };
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "pending-gaps-db-test-secret-0123456789";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-pending-"));
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

const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("./db");
const { changeAcks, snapshots, snapshotStats, spreadsheets, tabs, users } = await import("./db/schema");
const { captureSnapshot, decodeSnapshot, encodeSnapshot, toSnapshotData } = await import("./snapshots");
const { getPendingChanges } = await import("./pending");
const { importGis, startTracking } = await import("./actions");

const captureMock = vi.mocked(captureSnapshot);

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const signIn = (id: string | null) => {
  state.userId = id;
};

async function seedUser(id: string) {
  await db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@x.com`, name: id, tokensEnc: "unused", createdAt: 1 });
}
async function seedSheet(id: string, userId: string, title: string) {
  await db.insert(spreadsheets).values({
    id, userId, googleId: `gid-${id}`, title,
    url: `https://docs.google.com/spreadsheets/d/gid-${id}/edit`,
    createdAt: 1,
  });
}
async function seedTab(id: string, spreadsheetId: string, keyColumn: number | null, tracked = true) {
  await db.insert(tabs).values({ id, spreadsheetId, title: id, position: 0, tracked, keyColumn });
}
async function seedSnapshot(id: string, tabId: string, runId: string, trigger: "manual" | "import", isBaseline: boolean, createdAt: number, grid: string[][]) {
  const data = toSnapshotData(grid);
  await db.insert(snapshots).values({
    id, tabId, runId, trigger, isBaseline,
    rowCount: data.rows.length, colCount: data.headers.length,
    dataBlob: encodeSnapshot(data), createdAt,
  });
}
/** Like seedSnapshot but stores an arbitrary (undecodable) blob — for proving
 *  the quiet-day short-circuit returns before any blob is ever gunzip'd. */
async function seedRawBlobSnapshot(id: string, tabId: string, runId: string, trigger: "manual" | "import", isBaseline: boolean, createdAt: number, raw: Buffer) {
  await db.insert(snapshots).values({
    id, tabId, runId, trigger, isBaseline,
    rowCount: 0, colCount: 0, dataBlob: raw, createdAt,
  });
}
/** better-sqlite3 v13 enables `PRAGMA foreign_keys = ON` by default, so every
 *  stats row must reference a real snapshot id (as production does: stats are
 *  written capture-time, one row per snapshot). */
async function seedStats(snapshotId: string, tabId: string, createdAt: number, added: number, removed: number, changed: number) {
  await db.insert(snapshotStats).values({ snapshotId, tabId, added, removed, changed, createdAt });
}
const tabRow = async (id: string) => (await db.select().from(tabs).where(eq(tabs.id, id)))[0]!;

/** One pending-change history: base(S2=20) -> mid(S2=99) -> last(S2=99, S3 added).
 *  The mid snapshot exercises the introduction walk (between.length > 1):
 *  S2's new content was introduced at `midAt`, S3 at `lastAt`. */
async function seedWalkHistory(tabId: string, p: string, baseAt: number, midAt: number, lastAt: number) {
  await seedSnapshot(`${p}-base`, tabId, `${p}0`, "manual", true, baseAt, [["Shot", "Qty"], ["S1", "10"], ["S2", "20"]]);
  await seedSnapshot(`${p}-mid`, tabId, `${p}1`, "manual", false, midAt, [["Shot", "Qty"], ["S1", "10"], ["S2", "99"]]);
  await seedSnapshot(`${p}-last`, tabId, `${p}2`, "manual", false, lastAt, [["Shot", "Qty"], ["S1", "10"], ["S2", "99"], ["S3", "30"]]);
}

beforeAll(async () => {
  await seedUser("u1");
  await seedUser("ghost-user");

  await seedSheet("s-pend", "u1", "Pending");
  for (const t of ["tp1", "tp2", "tp3", "tn", "te", "ti", "tq", "tnz", "tq-noise"]) {
    await seedTab(t, "s-pend", 0);
  }
  await seedSheet("imp-sheet", "u1", "GIS Import");
  await seedTab("tab-pe", "imp-sheet", null); // tracked, title "pe-001" set below
  await seedTab("tab-zebra", "imp-sheet", null);
  await seedTab("tab-other", "imp-sheet", null, false); // untracked
  await db.update(tabs).set({ title: "pe-001" }).where(eq(tabs.id, "tab-pe"));
  await db.update(tabs).set({ title: "zebra-1" }).where(eq(tabs.id, "tab-zebra"));
  await db.update(tabs).set({ title: "other" }).where(eq(tabs.id, "tab-other"));

  await seedSheet("imp-sheet-csv", "u1", "GIS Import CSV");
  await seedTab("tab-csvA", "imp-sheet-csv", null); // inserted FIRST -> fallback target
  await seedTab("tab-csvB", "imp-sheet-csv", null);
  await db.update(tabs).set({ title: "csv-a" }).where(eq(tabs.id, "tab-csvA"));
  await db.update(tabs).set({ title: "csv-b" }).where(eq(tabs.id, "tab-csvB"));

  // tp1: no walk (2 snapshots), no acks — everything pending
  await seedSnapshot("tp1-base", "tp1", "tp1-0", "manual", true, 1000, [["Shot", "Qty"], ["S1", "10"], ["S2", "20"]]);
  await seedSnapshot("tp1-last", "tp1", "tp1-1", "manual", false, 2000, [["Shot", "Qty"], ["S1", "10"], ["S2", "99"], ["S3", "30"]]);

  // tp2/tp3: walk histories for fresh-ack vs stale-ack resolution
  await seedWalkHistory("tp2", "tp2", 1000, 2000, 3000);
  await seedWalkHistory("tp3", "tp3", 1000, 2000, 3000);

  // tn: snapshots but NO baseline; te: no snapshots at all
  await seedSnapshot("tn-1", "tn", "tn-0", "manual", false, 1000, [["Shot", "Qty"], ["S1", "1"]]);
  await seedSnapshot("tn-2", "tn", "tn-1", "manual", false, 2000, [["Shot", "Qty"], ["S1", "2"]]);

  // ti: newest snapshot is an IMPORT — must be excluded from latest
  await seedSnapshot("ti-base", "ti", "ti-0", "manual", true, 1000, [["Shot", "Qty"], ["S1", "1"], ["S2", "2"]]);
  await seedSnapshot("ti-last", "ti", "ti-1", "manual", false, 2000, [["Shot", "Qty"], ["S1", "1"], ["S2", "2"], ["S4", "4"]]);
  await seedSnapshot("ti-import", "ti", "ti-2", "import", false, 3000, [["Shot", "Qty"], ["S1", "1"], ["S2", "2"], ["S4", "4"], ["S9", "9"]]);

  // tq: quiet-day — undecodable blobs prove the short-circuit never reads them.
  // History: base@1000, s1@2000, s2@4500 (latest sheet snap), import@6000.
  await seedRawBlobSnapshot("tq-base", "tq", "tq-0", "manual", true, 1000, Buffer.from("not-a-gzip-blob-base"));
  await seedRawBlobSnapshot("tq-s1", "tq", "tq-1", "manual", false, 2000, Buffer.from("not-a-gzip-blob-s1"));
  await seedRawBlobSnapshot("tq-s2", "tq", "tq-2", "manual", false, 4500, Buffer.from("not-a-gzip-blob-latest"));
  await seedRawBlobSnapshot("tq-import", "tq", "tq-3", "import", false, 6000, Buffer.from("not-a-gzip-blob-import"));
  await seedStats("tq-s1", "tq", 2000, 0, 0, 0); // in window (1000, 4500]
  await seedStats("tq-s2", "tq", 4500, 0, 0, 0); // in window
  await seedStats("tq-import", "tq", 6000, 5, 0, 0); // AFTER latest — outside the window
  await seedStats("tq-base", "tq", 1000, 0, 0, 7); // AT baseline — gt() is strict, outside
  await seedRawBlobSnapshot("tqn-s1", "tq-noise", "tqn-0", "manual", false, 3000, Buffer.from("not-a-gzip-blob-noise"));
  await seedStats("tqn-s1", "tq-noise", 3000, 0, 0, 3); // other tab's stats — filtered by tabId

  // tnz: non-zero stats in window — must fall through to the real diff
  await seedSnapshot("tnz-base", "tnz", "tnz-0", "manual", true, 1000, [["Shot", "Qty"], ["S1", "1"]]);
  await seedSnapshot("tnz-mid", "tnz", "tnz-1", "manual", false, 1500, [["Shot", "Qty"], ["S1", "2"]]);
  await seedSnapshot("tnz-last", "tnz", "tnz-2", "manual", false, 5000, [["Shot", "Qty"], ["S1", "2"]]);
  await seedStats("tnz-mid", "tnz", 1500, 0, 0, 1);

  // acks: tp2's is newer than S2's introduction (2000) -> resolves;
  //       tp3's is older than S3's introduction (3000) -> does NOT resolve
  await db.insert(changeAcks).values({ id: crypto.randomUUID(), tabId: "tp2", rowKey: "s2", ackedAt: 2500 });
  await db.insert(changeAcks).values({ id: crypto.randomUUID(), tabId: "tp3", rowKey: "s3", ackedAt: 2500 });
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* WAL held open on Windows */ }
});

describe("temp-db harness", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("getPendingChanges assembly", () => {
  it("diffs baseline->latest and reports every change as unresolved (no acks)", async () => {
    const res = await getPendingChanges(await tabRow("tp1"));
    expect(res).not.toBeNull();
    expect(res!.latestAt).toBe(2000);
    expect(res!.baselineAt).toBe(1000);
    expect(res!.unresolved.map((r) => r.rowKey)).toEqual(["s2", "s3"]);
    expect(res!.unresolved.map((r) => r.status)).toEqual(["changed", "added"]);
    expect(res!.unresolved[0]!.cells).toEqual([{ col: 1, header: "Qty", from: "20", to: "99" }]);
    expect(res!.counts).toEqual({ added: 1, removed: 0, changed: 1, unresolved: 2 });
  });

  it("returns null when the tab has no baseline (and when it has no snapshots)", async () => {
    expect(await getPendingChanges(await tabRow("tn"))).toBeNull();
    expect(await getPendingChanges(await tabRow("te"))).toBeNull();
  });

  it("excludes GIS imports from 'latest' — the sheet snapshot is the target", async () => {
    const res = await getPendingChanges(await tabRow("ti"));
    expect(res).not.toBeNull();
    expect(res!.latestAt).toBe(2000); // the manual snapshot, NOT the import at 3000
    expect(res!.baselineAt).toBe(1000);
    expect(res!.unresolved.map((r) => r.rowKey)).toEqual(["s4"]); // S9 only exists in the import
    expect(res!.counts).toEqual({ added: 1, removed: 0, changed: 0, unresolved: 1 });
  });
});

describe("getPendingChanges ack resolution (end-to-end, with introduction walk)", () => {
  it("an ack newer than the snapshot that introduced the change resolves it", async () => {
    // S2's new value appeared at 2000 (mid); the ack at 2500 covers it.
    // If introduction were mis-dated to 3000 (the latest), this would stay unresolved.
    const res = await getPendingChanges(await tabRow("tp2"));
    expect(res!.unresolved.map((r) => r.rowKey)).toEqual(["s3"]);
    expect(res!.counts).toEqual({ added: 1, removed: 0, changed: 1, unresolved: 1 });
  });

  it("an ack older than the introduction does NOT resolve the change", async () => {
    // S3 was introduced at 3000; the ack at 2500 is stale -> still pending.
    const res = await getPendingChanges(await tabRow("tp3"));
    expect(res!.unresolved.map((r) => r.rowKey)).toEqual(["s2", "s3"]);
    expect(res!.counts.unresolved).toBe(2);
  });
});

describe("getPendingChanges quiet-day short-circuit", () => {
  it("stats summing to zero over (baseline, latest] return null WITHOUT reading any blob", async () => {
    // All five tq blobs are garbage: if the short-circuit were broken,
    // fetchBlobs() would gunzip baseline+latest and this call would reject
    // loudly instead of resolving null. The non-zero rows (after latest, at
    // baseline, other tab) must be excluded from the quiet sum.
    const tq = await tabRow("tq");
    const result = await getPendingChanges(tq);
    // with complete stats coverage and all zeros, this MUST be null (quiet)
    // — if it fell through, the garbage blobs would throw on gunzip
    expect(result).toBeNull();
  });

  it("non-zero stats in the window fall through to the real 2-blob diff", async () => {
    const res = await getPendingChanges(await tabRow("tnz"));
    expect(res).not.toBeNull();
    expect(res!.latestAt).toBe(5000);
    expect(res!.unresolved.map((r) => r.rowKey)).toEqual(["s1"]);
    expect(res!.counts).toEqual({ added: 0, removed: 0, changed: 1, unresolved: 1 }); // diff agrees with the materialized stats
  });
});

/* ------------------------------------------------------------------ */
/* importGis                                                           */
/* ------------------------------------------------------------------ */

async function xlsxFile(sheets: [string, string[][]][]): Promise<File> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], "tracker.xlsx");
}
const runIdFrom = (message: string) => /imported=([0-9a-f-]{36})/.exec(message)![1]!;
const importErr = (promise: Promise<void>) =>
  promise.then(
    () => { throw new Error("importGis resolved — expected a REDIRECT throw"); },
    (e: Error) => e,
  );

describe("importGis xlsx", () => {
  it("stores nothing when no worksheet matches, then redirects with import-no-match", async () => {
    signIn("u1");
    const file = await xlsxFile([
      ["OTHER", [["A"], ["b"]]], // matches the UNTRACKED tab "other" by name — must still not store
      ["MISMATCH", [["A"]]],
    ]);
    const form = fd({ spreadsheetId: "imp-sheet" });
    form.set("file", file);
    const err = await importErr(importGis(form));
    expect(err.message).toMatch(/^REDIRECT:\/sheets\/imp-sheet\?error=import-no-match$/);

    const impTabs = ["tab-pe", "tab-zebra", "tab-other"];
    const imports = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.trigger, "import"), inArray(snapshots.tabId, impTabs)));
    expect(imports).toHaveLength(0); // nothing stored — untracked tabs never match
  });

  it("matches worksheet names to tracked tabs case-insensitively and stores an import snapshot", async () => {
    signIn("u1");
    const file = await xlsxFile([
      ["PE-001", [["Activity", "Start STA", "End STA"], ["Plow", "0", "500"]]],
    ]);
    const form = fd({ spreadsheetId: "imp-sheet" });
    form.set("file", file);
    const err = await importErr(importGis(form));
    expect(err.message).toMatch(/^REDIRECT:\/sheets\/imp-sheet\?tab=pe-001&imported=[0-9a-f-]{36}$/);

    const rows = await db.select().from(snapshots).where(eq(snapshots.runId, runIdFrom(err.message)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tabId).toBe("tab-pe");
    expect(rows[0]!.trigger).toBe("import");
    expect(rows[0]!.isBaseline).toBe(false);
    expect(rows[0]!.rowCount).toBe(1); // header excluded
    expect(decodeSnapshot(rows[0]!.dataBlob).headers).toEqual(["Activity", "Start STA", "End STA"]);
    expect(decodeSnapshot(rows[0]!.dataBlob).rows).toEqual([["Plow", "0", "500"]]);
  });
});

describe("importGis csv", () => {
  const csvForm = (tabId: string) => {
    const form = fd({ spreadsheetId: "imp-sheet-csv", tabId });
    form.set("file", new File(["Shot,Qty\nS1,5\n"], "gis.csv", { type: "text/csv" }));
    return form;
  };

  it("lands on the explicitly chosen tab", async () => {
    signIn("u1");
    const err = await importErr(importGis(csvForm("tab-csvB")));
    expect(err.message).toMatch(/^REDIRECT:\/sheets\/imp-sheet-csv\?tab=csv-b&imported=[0-9a-f-]{36}$/);

    const rows = await db.select().from(snapshots).where(eq(snapshots.runId, runIdFrom(err.message)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tabId).toBe("tab-csvB");
    expect(rows[0]!.trigger).toBe("import");
    expect(rows[0]!.rowCount).toBe(1);
    expect(decodeSnapshot(rows[0]!.dataBlob).rows).toEqual([["S1", "5"]]);
  });

  it("falls back to the first tracked tab when the tabId param matches nothing", async () => {
    signIn("u1");
    // better-sqlite3 returns tabs in insertion (rowid) order -> csv-a is first
    const err = await importErr(importGis(csvForm("no-such-tab")));
    expect(err.message).toMatch(/^REDIRECT:\/sheets\/imp-sheet-csv\?tab=csv-a&imported=[0-9a-f-]{36}$/);

    const rows = await db.select().from(snapshots).where(eq(snapshots.runId, runIdFrom(err.message)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tabId).toBe("tab-csvA");
  });
});

/* ------------------------------------------------------------------ */
/* startTracking ghost-sheet cleanup                                   */
/* ------------------------------------------------------------------ */

const GOOGLE_URL = "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrst/edit"; // 20-char id

describe("startTracking", () => {
  it("deletes the sheet row when the first capture fails (no ghost sheets)", async () => {
    signIn("ghost-user");
    state.meta = { title: "Ghost Sheet", tabs: [{ title: "G1" }, { title: "G2" }] };
    let ghostId = "";
    captureMock.mockImplementationOnce((id: string) => {
      ghostId = id;
      return Promise.reject(new Error("google fetch blew up"));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await importErr(startTracking(fd({ url: GOOGLE_URL, tab: "G1", key_G1: "auto", cadence: "off" })));
      expect(err.message).toMatch(/^REDIRECT:\/sheets\/new\?url=/);
      expect(err.message).toContain("error=cannot-read");
      expect(await db.select().from(spreadsheets).where(eq(spreadsheets.userId, "ghost-user"))).toHaveLength(0);
      // FKs are enforced (better-sqlite3 default), so the tabs row cascades away too
      expect(await db.select().from(tabs).where(eq(tabs.spreadsheetId, ghostId))).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("happy plumbing: inserts sheet + selected tabs only, then redirects (capture mocked)", async () => {
    signIn("ghost-user");
    state.meta = { title: "Live Sheet", tabs: [{ title: "G1" }, { title: "G2" }] };
    captureMock.mockResolvedValueOnce({ runId: "ghost-run", createdAt: 1, tabCount: 1, rowCount: 0 });
    const err = await importErr(startTracking(fd({ url: GOOGLE_URL, tab: "G1", key_G1: "0", cadence: "daily-9" })));
    expect(err.message).toMatch(/^REDIRECT:\/sheets\/[0-9a-f-]{36}$/);

    const sheetRows = await db.select().from(spreadsheets).where(eq(spreadsheets.userId, "ghost-user"));
    expect(sheetRows).toHaveLength(1);
    expect(sheetRows[0]!.title).toBe("Live Sheet");
    expect(sheetRows[0]!.scheduleKind).toBe("daily");
    expect(sheetRows[0]!.scheduleTime).toBe("09:00");

    const tabRows = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheetRows[0]!.id));
    expect(tabRows.map((t) => t.title)).toEqual(["G1"]); // G2 was not selected
    expect(tabRows[0]!.keyColumn).toBe(0); // "0" -> column 0
    expect(captureMock).toHaveBeenCalledWith(sheetRows[0]!.id, "manual");
  });
});
