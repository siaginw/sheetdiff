/**
 * Dedicated coverage for the blank-key fallthrough in diffSnapshots (the
 * biggest engine change since inception — previously untested):
 *
 *   blankKeyedA/blankKeyedB rows (blank key-column value OR blank composite
 *   Activity+stations identity) fall through the key pass into a content-hash
 *   pass over the shared columns, with positional pairing only for the
 *   leftovers. This replaced the dead `if (false)` legacy block: real trackers
 *   pad tabs with hundreds of label-only rows whose composite key is blank,
 *   and treating those as remove+add pairs poisoned every downstream consumer.
 *
 * Fixtures use the production tracker vocabulary (Activity + Start/End STA
 * composite identity, see detect.ts) so the composite path actually engages —
 * each test pins `summary.keyColumnHeader` where the mechanism matters.
 *
 * The final describe is the auto-baseline DB test (first capture sets
 * isBaseline=true), using the temp-SQLite harness pattern from
 * actions.db.test.ts / pending-gaps.db.test.ts. snapshots.ts imports no
 * next/* modules, so only ./google (one directory up) needs mocking.
 */
import { vi } from "vitest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { diffSnapshots, type SnapshotData } from "./engine";

/* ------------------------------------------------------------------ */
/* pure engine fixtures                                                */
/* ------------------------------------------------------------------ */

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

/** Tracker vocabulary that engages the composite identity (no ID column). */
const TRACKER_HEADERS = ["Activity", "Start STA", "End STA", "Crew #", "Notes"];
const tSnap = (rows: string[][]) => snap(TRACKER_HEADERS, rows);

/** Composite-keyed (identifiable) rows: Activity + stations all present. */
const KEYED_ROWS: string[][] = [
  ["Plow", "0", "500", "BIG M P1", ""],
  ["Bore", "500", "14800", "HAIDER 1", ""],
  ["Cobble Adder", "846", "922", "HAIDER 2", ""],
];

/** A blank-key padded row: identity columns empty, label elsewhere. */
const padRow = (label = "") => ["", "", "", "", label];

const padTail = (n: number, label = ""): string[][] => Array.from({ length: n }, () => padRow(label));

function count(result: ReturnType<typeof diffSnapshots>, status: string) {
  return result.rows.filter((r) => r.status === status).length;
}

/* ------------------------------------------------------------------ */
/* 1. identical snapshots with blank-key padded rows                   */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: identical padded snapshots (the 150-tail scenario)", () => {
  it("150 fully-blank tail rows match their twins — zero changes of any kind", () => {
    const a = tSnap([...structuredClone(KEYED_ROWS), ...padTail(150)]);
    const b = tSnap([...structuredClone(KEYED_ROWS), ...padTail(150)]);
    const r = diffSnapshots(a, b);
    // the composite path really engaged (otherwise this would pass trivially)
    expect(r.summary.keyColumnHeader).toContain("Activity");
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.changedCells).toBe(0);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(r.summary.movedRows).toBe(0); // positional pairs land on i === k
    expect(r.summary.unchangedRows).toBe(153);
    expect(count(r, "unchanged")).toBe(153);
  });

  it("label-only padded rows (blank composite, repeated label) match by content hash", () => {
    const a = tSnap([...structuredClone(KEYED_ROWS), ...padTail(40, "ZONE 2")]);
    const b = tSnap([...structuredClone(KEYED_ROWS), ...padTail(40, "ZONE 2")]);
    const r = diffSnapshots(a, b);
    expect(r.summary.keyColumnHeader).toContain("Activity");
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(r.summary.unchangedRows).toBe(43);
  });
});

/* ------------------------------------------------------------------ */
/* 2. a padded row gets a value typed in                               */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: a padded row gets a VALUE typed in", () => {
  it("reports exactly one changed row with one cell (identity columns stay blank)", () => {
    const a = [...structuredClone(KEYED_ROWS), ...padTail(5)];
    const b = structuredClone(a);
    b[6][3] = "HAIDER 9"; // crew typed into the 4th padded row — composite stays blank
    const r = diffSnapshots(tSnap(a), tSnap(b));
    expect(r.summary.keyColumnHeader).toContain("Activity");
    expect(r.summary.changedRows).toBe(1);
    expect(r.summary.changedCells).toBe(1);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0); // NOT a remove+add pair
    expect(r.summary.movedRows).toBe(0);
    expect(r.summary.unchangedRows).toBe(7);
    const changed = r.rows.find((x) => x.status === "changed")!;
    expect(changed.newIndex).toBe(6);
    expect(changed.movedFrom).toBeNull();
    expect(changed.key).toBeNull(); // blank identity -> keyless row
    expect(changed.cells[0]).toMatchObject({ header: "Crew #", from: "", to: "HAIDER 9" });
    expect(typeof changed.rowKey).toBe("string"); // content-hash identity exists
  });
});

/* ------------------------------------------------------------------ */
/* 3. keyed row content vs blank row — no false match                  */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: keyed rows never match blank-key rows", () => {
  it("single key: blank row with content identical to a removed keyed row stays added+removed", () => {
    const a = snap(["ID", "Name", "Qty"], [
      ["1", "Widget", "40"],
      ["2", "Gadget", "7"],
    ]);
    const b = snap(["ID", "Name", "Qty"], [
      ["2", "Gadget", "7"],
      ["", "Widget", "40"], // same content as row 1, but blank key
    ]);
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    expect(r.summary.keyColumnIndex).toBe(0);
    expect(r.summary.changedRows).toBe(0); // the whole point: no false "change"
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1);
    expect(r.summary.movedRows).toBe(1); // row 2 shifted up
    expect(r.rows.find((x) => x.status === "added")!.values).toEqual(["", "Widget", "40"]);
    expect(r.rows.find((x) => x.status === "removed")!.key).toBe("1");
  });

  it("composite key: a blank row sharing a keyed row's non-identity cells stays added+removed", () => {
    const a = tSnap(structuredClone(KEYED_ROWS));
    const b = tSnap([
      KEYED_ROWS[1], // Bore
      KEYED_ROWS[2], // Cobble Adder
      ["", "", "", "", "BIG M P1"], // Plow row's crew label, blank identity
    ]);
    const r = diffSnapshots(a, b);
    expect(r.summary.keyColumnHeader).toContain("Activity");
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1); // the keyed Plow row — never content-matched
    expect(r.summary.movedRows).toBe(2);
    expect(r.rows.find((x) => x.status === "removed")!.key).toContain("plow");
    expect(r.rows.find((x) => x.status === "added")!.key).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4. blank rows deleted                                               */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: blank rows DELETED between snapshots", () => {
  it("unmatched padded rows are reported as removed, never silently matched", () => {
    const a = tSnap([
      ...structuredClone(KEYED_ROWS),
      padRow("NOTE-1"),
      padRow("NOTE-2"),
      padRow("NOTE-3"),
      padRow(), // fully blank
    ]);
    const b = tSnap([...structuredClone(KEYED_ROWS), padRow("NOTE-2")]);
    const r = diffSnapshots(a, b);
    expect(r.summary.keyColumnHeader).toContain("Activity");
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(3); // NOTE-1, NOTE-3 and the blank row
    expect(r.summary.movedRows).toBe(0); // NOTE-2 shifted 4 -> 3 but blank-keyed moves are noise, not activity
    expect(r.summary.unchangedRows).toBe(4); // NOTE-2 matched by content = unchanged
    const removedNotes = r.rows.filter((x) => x.status === "removed").map((x) => x.values[4]);
    expect(removedNotes).toEqual(["NOTE-1", "NOTE-3", ""]);
    expect(r.rows.filter((x) => x.status === "removed").every((x) => x.key === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. blank rows added                                                 */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: blank rows ADDED between snapshots", () => {
  it("new padded rows are reported as added, keyed rows untouched", () => {
    const a = tSnap([...structuredClone(KEYED_ROWS), padRow("NOTE-1")]);
    const b = tSnap([
      ...structuredClone(KEYED_ROWS),
      padRow("NOTE-1"), // same as before
      padRow("NOTE-2"), // new
      padRow("NOTE-3"), // new
      padRow(), // new, fully blank
    ]);
    const r = diffSnapshots(a, b);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(r.summary.addedRows).toBe(3);
    expect(r.summary.unchangedRows).toBe(4);
    const addedNotes = r.rows.filter((x) => x.status === "added").map((x) => x.values[4]);
    expect(addedNotes).toEqual(["NOTE-2", "NOTE-3", ""]);
    expect(r.rows.filter((x) => x.status === "added").every((x) => x.key === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 6. keyed and blank rows in reversed order                           */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: full reversal of a mixed sheet", () => {
  it("keyed rows match by key, blank rows by content — no cross-contamination", () => {
    const a = tSnap([
      ["Plow", "0", "500", "CREW A", ""],
      ["Bore", "500", "14800", "CREW B", ""],
      padRow("PAD-1"),
      padRow("PAD-2"),
    ]);
    const b = tSnap([
      padRow("PAD-2"),
      padRow("PAD-1"),
      ["Bore", "500", "14800", "CREW B", ""],
      ["Plow", "0", "500", "CREW A", ""],
    ]);
    const r = diffSnapshots(a, b);
    expect(r.summary.keyColumnHeader).toContain("Activity"); // composite engaged
    expect(r.summary.changedRows).toBe(0); // positional pairing alone would flag PAD rows
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(r.summary.movedRows).toBe(2); // only keyed rows count as moved (blank-keyed moves are noise)
    expect(count(r, "moved")).toBe(2); // only keyed rows; blank-keyed matches are unchanged
    // B order: blank rows first, keyed rows after — each kept its own identity
    expect(r.rows.map((x) => x.status).sort()).toEqual(["moved", "moved", "unchanged", "unchanged"]);
    expect(r.rows[0]!.key).toBeNull(); // blank row matched by content
    expect(r.rows[0]!.values[4]).toBe("PAD-2");
    expect(r.rows[1]!.values[4]).toBe("PAD-1");
    expect(r.rows[3]!.key).toContain("plow"); // keyed row matched by composite
    expect(r.rows[3]!.values[0]).toBe("Plow");
  });
});

/* ------------------------------------------------------------------ */
/* 6b. blank keys with an explicit single key column                   */
/* ------------------------------------------------------------------ */

describe("blank-key fallthrough: explicit single key column with blank-key rows", () => {
  it("duplicate-content blank-key rows pair through the content queue", () => {
    const a = snap(["ID", "Name"], [
      ["1", "real"],
      ["", "pad"],
      ["", "pad"],
    ]);
    const b = structuredClone(a);
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    expect(r.summary.keyColumnIndex).toBe(0);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(r.summary.unchangedRows).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 7. regression guard — keyed-only sheets behave exactly as before    */
/* ------------------------------------------------------------------ */

describe("regression guard: sheets with ONLY keyed rows are unaffected", () => {
  const base = snap(["ID", "Name", "Qty"], [
    ["1", "Nails", "40"],
    ["2", "Screws", "100"],
    ["3", "Bolts", "55"],
  ]);

  it("identical snapshots: nothing changes, key column still auto-detected", () => {
    const r = diffSnapshots(base, structuredClone(base));
    expect(r.summary.keyColumnIndex).toBe(0);
    expect(r.summary.keyColumnHeader).toBe("ID");
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(count(r, "unchanged")).toBe(3);
  });

  it("a single cell edit is one changed row carrying the key", () => {
    const next = structuredClone(base);
    next.rows[1][2] = "125";
    const r = diffSnapshots(base, next);
    expect(r.summary.changedRows).toBe(1);
    const changed = r.rows.find((x) => x.status === "changed")!;
    expect(changed.key).toBe("2");
    expect(changed.rowKey).toBe("2");
    expect(changed.cells[0]).toMatchObject({ header: "Qty", from: "100", to: "125" });
  });

  it("a full sort is moves only, never false changes", () => {
    const sorted = snap(["ID", "Name", "Qty"], [
      ["3", "Bolts", "55"],
      ["1", "Nails", "40"],
      ["2", "Screws", "100"],
    ]);
    const r = diffSnapshots(base, sorted);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.movedRows).toBe(3);
  });

  it("an edited key is still remove + add (identity changed)", () => {
    const next = structuredClone(base);
    next.rows[0][0] = "9";
    const r = diffSnapshots(base, next);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* auto-baseline: first capture sets isBaseline=true (temp real DB)    */
/* ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({
  tabValues: {} as Record<string, string[][]>,
}));

vi.mock("../google", () => ({
  parseSpreadsheetId: (s: string) => s.match(/[a-zA-Z0-9-_]{20,}/)?.[0] ?? null,
  fetchSpreadsheetMeta: async () => ({ title: "Scratch", tabs: [] }),
  getUserClient: async () => ({}),
  fetchTabValues: async () => state.tabValues,
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// vitest hoists static imports above module-body statements, so the temp
// DATABASE_PATH must be set BEFORE any ../db-dependent import — hence the
// dynamic imports below (same contract as the other *.db.test.ts files).
process.env.APP_SECRET ??= "blankkey-db-test-secret-0123456789";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-blankkey-"));
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
const { db } = await import("../db");
const { snapshots, snapshotStats, spreadsheets, tabs, users } = await import("../db/schema");
const { captureSnapshot, decodeSnapshot } = await import("../snapshots");

const TAB_ID = "bk-tab";
const SHEET_ID = "bk-sheet";

beforeAll(async () => {
  await db.insert(users).values({ id: "bk-user", googleSub: "sub-bk", email: "bk@x.com", name: "bk", tokensEnc: "unused", createdAt: 1 });
  await db.insert(spreadsheets).values({
    id: SHEET_ID, userId: "bk-user", googleId: "gid-blankkey", title: "Padded Tracker",
    url: "https://docs.google.com/spreadsheets/d/gid-blankkey/edit",
    createdAt: 1,
  });
  await db.insert(tabs).values({ id: TAB_ID, spreadsheetId: SHEET_ID, title: "Tracker", position: 0, tracked: true });
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* WAL held open on Windows */ }
});

describe("auto-baseline (captureSnapshot against a temp real database)", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });

  it("the FIRST capture of a tab sets isBaseline=true on its snapshot row", async () => {
    state.tabValues = { Tracker: [["Shot", "Qty"], ["S1", "5"]] };
    const run = await captureSnapshot(SHEET_ID, "manual");
    expect(run.tabCount).toBe(1);

    const rows = await db.select().from(snapshots).where(eq(snapshots.runId, run.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tabId).toBe(TAB_ID);
    expect(rows[0]!.isBaseline).toBe(true); // first-ever snapshot auto-baselines
    expect(rows[0]!.trigger).toBe("manual");
    expect(rows[0]!.rowCount).toBe(1); // header excluded
    expect(decodeSnapshot(rows[0]!.dataBlob).rows).toEqual([["S1", "5"]]);
    // nothing to diff against yet — no stats row for the first capture
    expect(await db.select().from(snapshotStats).where(eq(snapshotStats.tabId, TAB_ID))).toHaveLength(0);
  });

  it("subsequent captures are NOT baselines; exactly one baseline row remains", async () => {
    state.tabValues = { Tracker: [["Shot", "Qty"], ["S1", "6"]] };
    const run = await captureSnapshot(SHEET_ID, "scheduled");

    const rows = await db.select().from(snapshots).where(eq(snapshots.tabId, TAB_ID));
    expect(rows).toHaveLength(2); // better-sqlite3 returns rowid (insertion) order
    expect(rows.filter((r) => r.isBaseline)).toHaveLength(1);
    expect(rows[0]!.isBaseline).toBe(true);
    expect(rows[1]!.isBaseline).toBe(false);
    expect(rows[1]!.runId).toBe(run.runId);

    // capture-time stats: S1's Qty 5 -> 6 is exactly one changed row
    const stats = await db.select().from(snapshotStats).where(eq(snapshotStats.tabId, TAB_ID));
    expect(stats).toHaveLength(1);
    expect(stats[0]!.snapshotId).toBe(rows[1]!.id);
    expect({ added: stats[0]!.added, removed: stats[0]!.removed, changed: stats[0]!.changed })
      .toEqual({ added: 0, removed: 0, changed: 1 });
  });
});
