/**
 * DB tests for the Billing-Day Packet route — the newest and most complex
 * export: it loops EVERY tracked tab, queries each tab's baseline, sums
 * placed-since-collection footage, ages open holes, detects late entries,
 * collects unresolved (to-enter) changes, and stamps the CSV with provenance
 * ("COULD NOT DETERMINE" when no tab has a baseline).
 *
 * Same harness contract as actions.db.test.ts / pending-gaps.db.test.ts:
 *  - temp DATABASE_PATH set before any db-dependent import (all dynamic);
 *    the first test pins the connection to the temp file.
 *  - next/headers is mocked with a genuinely signed session cookie; the
 *    access layer, pending changes, gap report, production analytics and
 *    billing assembly all run REAL against the temp database.
 *  - "@/lib/google" is mocked (the route never calls it; snapshots.ts's
 *    static import of googleapis stays light). The "@" alias is mapped in
 *    vitest.config.ts to mirror tsconfig paths.
 *
 * Fixture timeline (both tracked tabs share it; Gamma is UNTRACKED and must
 * never contribute; the trigger="import" snapshot at T3 must be ignored):
 *   T0 baseline | T1 mid (tab A only) | T2 latest | T3 import
 *
 * Expected aggregates:
 *   sinceFt   = tab A (800-500) + tab B (1100-1000) = 400
 *   openHoleFt= tab A's unaccounted 500-700          = 200
 *   toEnter   = tab A (1 changed + 2 added) + tab B (1 added) = 4
 *   late      = tab A's bore dated 8/10/2026 first seen at T2 = 1
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

import { beforeAll, describe, expect, it } from "vitest";
import { setupMigratedTempDb } from "@/test/db-harness";

setupMigratedTempDb("billing");

const { db } = await import("@/lib/db");
const { changeAcks, snapshots, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { absoluteTime } = await import("@/lib/format");
const { GET } = await import("./route");

const signIn = (id: string | null) => {
  state.userId = id;
};
const get = (id: string) =>
  GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });

async function seedUser(id: string, email: string) {
  await db.insert(users).values({ id, googleSub: `sub-${id}`, email, name: id, tokensEnc: "unused", createdAt: 1 });
}
async function seedSheet(id: string, userId: string, title: string) {
  await db.insert(spreadsheets).values({
    id, userId, googleId: `gid-${id}`, title,
    url: `https://docs.google.com/spreadsheets/d/gid-${id}/edit`,
    createdAt: 1,
  });
}
async function seedTab(id: string, spreadsheetId: string, tracked = true) {
  await db.insert(tabs).values({ id, spreadsheetId, title: id, position: 0, tracked, keyColumn: 0 });
}
async function seedSnapshot(id: string, tabId: string, runId: string, trigger: "manual" | "import", isBaseline: boolean, createdAt: number, grid: string[][]) {
  const data = toSnapshotData(grid);
  await db.insert(snapshots).values({
    id, tabId, runId, trigger, isBaseline,
    rowCount: data.rows.length, colCount: data.headers.length,
    dataBlob: encodeSnapshot(data), createdAt,
  });
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 25); // baseline
const T1 = T0 + 2 * DAY; // mid (tab A)
const T2 = T0 + 4 * DAY; // latest
const T3 = T0 + 5 * DAY; // GIS import — excluded everywhere

const H = ["Activity", "Start STA", "End STA", "Crew #", "Date Complete"];
const grid = (...rows: string[][]) => [H, ...rows];

const SHEET = "bill-sheet";
const TAB_A = "bill-a";
const TAB_B = "bill-b";
const TAB_GAMMA = "bill-gamma"; // tracked=false

beforeAll(async () => {
  await seedUser("owner", "owner@corp.com");
  await seedUser("stranger", "mallory@evil.example");
  await seedSheet(SHEET, "owner", "Billing Tracker");

  await seedTab(TAB_A, SHEET);
  await seedTab(TAB_B, SHEET);
  await seedTab(TAB_GAMMA, SHEET, false);

  // Tab A: baseline plow 0-500 (CREW A) -> mid adds bore 700-900 + crew fix ->
  // latest adds a LATE bore 900-1000 dated 8/10/2026. Chain hole 500-700 opens
  // at T1 and is still open at T2 (200 ft).
  await seedSnapshot("ba-base", TAB_A, "ba0", "manual", true, T0,
    grid(["Plow", "0", "500", "CREW A", "8/20/2026"]));
  await seedSnapshot("ba-mid", TAB_A, "ba1", "manual", false, T1,
    grid(
      ["Plow", "0", "500", "CREW Z", "8/20/2026"], // crew changed vs baseline
      ["Bore", "700", "900", "HAIDER 1", "8/26/2026"], // entered same-week: NOT late
    ));
  await seedSnapshot("ba-last", TAB_A, "ba2", "manual", false, T2,
    grid(
      ["Plow", "0", "500", "CREW Z", "8/20/2026"],
      ["Bore", "700", "900", "HAIDER 1", "8/26/2026"],
      ["Bore", "900", "1000", "HAIDER 1", "8/10/2026"], // entered 2+ weeks late
    ));
  await seedSnapshot("ba-import", TAB_A, "ba3", "import", false, T3,
    grid(["Plow", "0", "9999", "X", "8/25/2026"])); // must never leak in

  // Tab B: contiguous chain, one new bore since baseline (no holes, no lates).
  await seedSnapshot("bb-base", TAB_B, "bb0", "manual", true, T0,
    grid(["Plow", "0", "1000", "CREW B", "8/19/2026"]));
  await seedSnapshot("bb-last", TAB_B, "bb1", "manual", false, T2,
    grid(
      ["Plow", "0", "1000", "CREW B", "8/19/2026"],
      ["Bore", "1000", "1100", "CREW C", "8/28/2026"],
    ));

  // Untracked tab with wild numbers — must contribute nothing.
  await seedSnapshot("bg-last", TAB_GAMMA, "bg0", "manual", true, T2,
    grid(["Plow", "0", "5000", "G", "8/25/2026"]));

  // A sheet with snapshots but NO baseline (sinceFt unknowable) and a sheet
  // whose tabs are all untracked (400).
  await seedSheet("no-base", "owner", "No Baseline");
  await seedTab("nb-1", "no-base");
  await seedSnapshot("nb-1a", "nb-1", "nb0", "manual", false, T0, grid(["Plow", "0", "100", "C", "8/20/2026"]));
  await seedSnapshot("nb-1b", "nb-1", "nb1", "manual", false, T2, grid(["Plow", "0", "200", "C", "8/28/2026"]));

  await seedSheet("no-tabs", "owner", "No Tracked Tabs");
  await seedTab("nt-1", "no-tabs", false);

  // Office-pipeline sheet: the tab carries its own "Entered in InEight"
  // column. Completed-but-unentered rows must surface as billing to-enter
  // rows via the office backlog (stuck + aging buckets — never "normal").
  const OH = ["Activity", "Start STA", "End STA", "Crew #", "Date Complete", "Entered in InEight"];
  const daysAgo = (days: number) => {
    const d = new Date(Date.now() - days * DAY);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  };
  await seedSheet("off-sheet", "owner", "Office Tracker");
  await seedTab("off-1", "off-sheet");
  await seedSnapshot("of-base", "off-1", "of0", "manual", true, T0, [OH]);
  await seedSnapshot("of-last", "off-1", "of1", "manual", false, T2, [
    OH,
    ["Stuck Bore", "0", "100", "CREW S", daysAgo(20), ""], // stuck: blank in the entered column
    ["Aging Bore", "100", "200", "CREW A", daysAgo(5), ""], // aging
    ["Fresh Plow", "200", "300", "CREW F", daysAgo(1), ""], // normal — NOT billing material
    ["Done Plow", "300", "400", "CREW D", daysAgo(10), "9/1/2026"], // already entered downstream
  ]);

  // Copy-tab sheet: cd-b (position 1) duplicates cd-a's rows verbatim. The
  // CSV must count each shot once — the route shipped with a `seenRows` set
  // that was declared but never used (its own commit message claimed the
  // dedup was applied), so the artifact handed to accounting doubled every
  // hole and every placed foot on copy-tab sheets while the dashboard page
  // showed the honest numbers.
  await seedSheet("csv-copy", "owner", "CSV Copy Tracker");
  await db.insert(tabs).values({ id: "cd-a", spreadsheetId: "csv-copy", title: "cd-a", position: 0, tracked: true, keyColumn: 0 });
  await db.insert(tabs).values({ id: "cd-b", spreadsheetId: "csv-copy", title: "cd-b", position: 1, tracked: true, keyColumn: 0 });
  await seedSnapshot("cc-a-base", "cd-a", "cc0", "manual", true, T0, grid(["Plow", "0", "500", "CREW A", "8/20/2026"]));
  await seedSnapshot("cc-a-last", "cd-a", "cc1", "manual", false, T2, grid(
    ["Plow", "0", "500", "CREW A", "8/20/2026"],
    ["Bore", "700", "900", "CREW A", "8/28/2026"], // opens the 500-700 hole, +200 ft since baseline
  ));
  await seedSnapshot("cc-b-base", "cd-b", "cc2", "manual", true, T1, grid(["Plow", "0", "500", "CREW A", "8/20/2026"]));
  await seedSnapshot("cc-b-last", "cd-b", "cc3", "manual", false, T3, grid(
    ["Plow", "0", "500", "CREW A", "8/20/2026"],
    ["Bore", "700", "900", "CREW A", "8/28/2026"],
  ));
});

describe("temp-db harness", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("billing route: auth and preconditions", () => {
  it("401 when signed out", async () => {
    signIn(null);
    const res = await get(SHEET);
    expect(res.status).toBe(401);
  });

  it("404 for a sheet the caller cannot access", async () => {
    signIn("stranger");
    const res = await get(SHEET);
    expect(res.status).toBe(404);
  });

  it("400 when the sheet has no tracked tabs", async () => {
    signIn("owner");
    const res = await get("no-tabs");
    expect(res.status).toBe(400);
  });
});

describe("billing route: packet assembly across every tracked tab", () => {
  it("aggregates footage, holes, to-enter worklist and late entries into one CSV", async () => {
    signIn("owner");
    const res = await get(SHEET);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="sheetdiff-Billing-Tracker-billing-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const csv = await res.text();
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^# SheetDiff billing packet — generated /);
    // label = the LATEST MANUAL snapshot of the tracked tabs (the T3 import
    // must not win; both tracked tabs' latest is T2 so tab order can't matter)
    expect(lines[1]).toBe(`# Snapshot: ${absoluteTime(T2)}`);
    // the whole-sheet aggregates: 400 placed, one 200 ft hole, 4 to enter, 1 late
    expect(lines[2]).toBe(
      "# Placed since collection: 400 ft | Open holes: 200 ft | To enter: 4 | Late entries: 1",
    );
    expect(lines[3]).toBe("Kind,Detail,Ft,Note");

    const body = lines.slice(4);
    // footage summary row
    expect(body).toContain("FOOTAGE,Placed footage since last collection,400,");
    // the open hole, with its do-not-invoice note tagged with its tab (days-open
    // grows with the wall clock — match, don't pin)
    expect(body.some((l) => /^DO NOT INVOICE,Unaccounted 500-700 \(open \d+d\),200,do not invoice — unbooked footage \(bill-a\)$/.test(l))).toBe(true);
    // tab A's crew fix is on the worklist, tagged with its tab
    expect(body).toContain("TO ENTER,Crew #: CREW A -> CREW Z,,enter in office system (bill-a)");
    // NEW rows from both tabs carry the tab tag too (to-enter count 4 = 1
    // change + 2 additions on tab A, 1 addition on tab B)
    expect(body.filter((l) => l.startsWith("TO ENTER")).map((l) => l.trimEnd().split(",").pop())).toEqual([
      "enter in office system (bill-a)",
      "enter in office system (bill-a)",
      "enter in office system (bill-a)",
      "enter in office system (bill-b)",
    ]);
    // the late entry: row 3 of tab A's latest, dated 8/10/2026 (day count is
    // timezone-adjacent — match, don't pin). The detail contains a comma, so
    // it ships as ONE quoted field — this regex used to match the SPLIT
    // output of the quoting bug itself.
    expect(body.some((l) => /^LATE ENTRY,"Row 3 \(Bore\) dated 8\/10\/2026, entered \d+d late",,verify office system has it$/.test(l))).toBe(true);
  });

  it("an ack on the tab-A change drops exactly that row from the worklist", async () => {
    // tabs.keyColumn = 0 (Activity) — the plow row's rowKey is its raw key
    await db.insert(changeAcks).values({ id: crypto.randomUUID(), tabId: TAB_A, rowKey: "plow", ackedAt: T2 });
    signIn("owner");
    const res = await get(SHEET);
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n");
    // 3 to enter now: the crew fix resolved, the two additions remain
    expect(lines[2]).toBe(
      "# Placed since collection: 400 ft | Open holes: 200 ft | To enter: 3 | Late entries: 1",
    );
    expect(lines.join("\n")).not.toContain("Crew #: CREW A -> CREW Z");
  });
});

describe("billing route: unknowable footage says so, never a confident 0", () => {
  it("stamps COULD NOT DETERMINE when no tab has a baseline", async () => {
    signIn("owner");
    const res = await get("no-base");
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n");
    expect(lines[2]).toBe(
      "# Placed since collection: COULD NOT DETERMINE — verify collection marker | Open holes: 0 ft | To enter: 0 | Late entries: 0",
    );
  });
});

describe("billing route: office-entry backlog reaches the packet", () => {
  it("stuck and aging completed-but-unentered rows ship as to-enter rows, normal and entered ones don't", async () => {
    signIn("owner");
    const res = await get("off-sheet");
    expect(res.status).toBe(200);
    const body = (await res.text()).split("\n").slice(4);
    // stuck + aging rows, attributed to the sheet's own entered column and tab
    // (the entered-column name appears ONLY in the office-backlog meta)
    expect(body.some((l) => l.includes("Stuck Bore") && l.includes("unentered downstream") && l.includes("Entered in InEight"))).toBe(true);
    expect(body.some((l) => l.includes("Aging Bore") && l.includes("unentered downstream") && l.includes("Entered in InEight"))).toBe(true);
    // the normal-bucket row and the already-entered row never become office
    // lines (the fresh row still shows as a NEW to-enter row from the diff —
    // just never with the unentered-downstream office meta)
    expect(body.some((l) => l.includes("Fresh Plow") && l.includes("unentered downstream"))).toBe(false);
    expect(body.some((l) => l.includes("Done Plow") && l.includes("unentered downstream"))).toBe(false);
  });
});

describe("billing route: a copy tab must not double the CSV (the dead seenRows regression)", () => {
  it("counts placed footage and the open hole once, not once per tab that lists them", async () => {
    signIn("owner");
    const res = await get("csv-copy");
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n");
    // 200 ft since baseline and ONE 200 ft hole — cd-b's identical rows add
    // nothing. The copy tab's worklist is skipped too (same behavior as the
    // dashboard page): its "NEW row" is the same work cd-a already queued,
    // and asking the office to enter it twice is the bug, not the fix.
    expect(lines[2]).toBe(
      "# Placed since collection: 200 ft | Open holes: 200 ft | To enter: 1 | Late entries: 0",
    );
    const holeLines = lines.filter((l) => l.startsWith("DO NOT INVOICE,"));
    expect(holeLines).toHaveLength(1);
    // the hole is attributed to the FIRST tab in position order, never the copy
    expect(holeLines[0]).toMatch(/^DO NOT INVOICE,Unaccounted 500-700 \(open \d+d\),200,do not invoice — unbooked footage \(cd-a\)$/);
  });
});
