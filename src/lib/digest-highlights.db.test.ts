/**
 * Digest permit/stoppage highlights + the zero-week guard (Fleet-16):
 *  - the digest reuses the SAME detectors the sheet/report pages run, on the
 *    same deduped data the weekly position uses — so the Monday email says
 *    "2 crossings placed under unapproved permits" and "1 stoppage logged
 *    this week" instead of making Erin open the app to find out;
 *  - a DATED but station-less tab must never zero "this week": its 0-ft
 *    bucket owned the newest date and buried real production in the prior
 *    week. Weekly position now comes from station tabs only.
 *
 * Same harness contract as digest.db.test.ts: temp DATABASE_PATH before any
 * db-dependent import (all dynamic), sheets seeded straight into the schema.
 */
import { vi } from "vitest";

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async () => {} }) },
}));

import { setupMigratedTempDb } from "@/test/db-harness";
import { beforeAll, describe, expect, it } from "vitest";

process.env.SMTP_HOST ??= "smtp.test";
process.env.SMTP_USER ??= "user";
process.env.SMTP_PASS ??= "pass";
setupMigratedTempDb("digest-hl");

const { db } = await import("./db");
const { snapshots, spreadsheets, tabs, users } = await import("./db/schema");
const { encodeSnapshot, toSnapshotData } = await import("./snapshots");
const { buildDigestSheets } = await import("./digest");

const NOW = new Date("2026-08-30T12:00:00").getTime();
const DAY = 86_400_000;

// PE vocabulary: stations + dates + a permit column — the working tab
const PE = ["Activity", "Start STA", "End STA", "Date Complete", "Permit Package"];

async function seedSheet(id: string, title: string) {
  await db.insert(spreadsheets).values({
    id,
    userId: "u1",
    googleId: `g-${id}`,
    title,
    url: "https://x",
    createdAt: 1,
    scheduleKind: "daily",
    lastSnapshotAt: NOW - 3_600_000,
  });
}
async function seedTab(id: string, spreadsheetId: string, title: string, position: number, tracked: boolean) {
  await db.insert(tabs).values({ id, spreadsheetId, title, position, tracked });
}
async function seedSnapshot(id: string, tabId: string, runId: string, grid: string[][]) {
  const data = toSnapshotData(grid);
  await db.insert(snapshots).values({
    id,
    tabId,
    runId,
    trigger: "manual",
    isBaseline: false,
    rowCount: data.rows.length,
    colCount: data.headers.length,
    dataBlob: encodeSnapshot(data),
    createdAt: NOW - 2 * DAY,
  });
}

/** hp1: permit tracker + work stoppages join the digest on deduped data. */
const HP1 = "hp1";
/** hp2: a dated station-less tab must not zero "this week". */
const HP2 = "hp2";
/** hp3: the stoppage log trails the work — the quiet-log guard fires. */
const HP3 = "hp3";

beforeAll(async () => {
  await db.insert(users).values({
    id: "u1",
    googleSub: "s1",
    email: "u@x.com",
    name: "u1",
    tokensEnc: "x",
    digestEmail: "me@x.com",
    digestTime: "07:00",
    digestDay: null,
    createdAt: 1,
  });

  await seedSheet(HP1, "Highlight Tracker");
  await seedTab("hp1-pe", HP1, "PE-4", 0, true);
  await seedSnapshot("hp1-pe-s", "hp1-pe", "hp1a", [
    PE,
    ["Bore", "0", "500", "8/20/2026", "PERM-101"], // approved — fine
    ["Bore", "500", "900", "8/21/2026", "PERM-102"], // placed under "In Review" — finding
  ]);
  await seedTab("hp1-tot", HP1, "TOTALS", 1, true);
  await seedSnapshot("hp1-tot-s", "hp1-tot", "hp1b", [
    ["Package", "Designed", "Placed", "Permit #"],
    ["PE-4", "900", "900", "PERM-101"], // designed with a permit — fine
    ["PE-9", "2,000", "0", ""], // designed, no permit listed — finding
  ]);
  // the joins read UNTRACKED log tabs too (tracked or not, like the pages)
  await seedTab("hp1-perm", HP1, "Permit Tracker", 2, false);
  await seedSnapshot("hp1-perm-s", "hp1-perm", "hp1c", [
    ["Permit #", "Status", "Agency", "Submitted"],
    ["PERM-101", "Approved", "City of Springfield", "5/2/2026"],
    ["PERM-102", "In Review", "City of Springfield", "8/1/2026"], // <30d — no aging noise
  ]);
  // widened date-header vocabulary on the log ("Date of Stoppage", not "Date")
  await seedTab("hp1-stop", HP1, "Work Stoppages", 3, false);
  await seedSnapshot("hp1-stop-s", "hp1-stop", "hp1d", [
    ["Date of Stoppage", "Description"],
    ["8/20/2026", "waiting on utility locate"], // same Monday bucket as the footage
  ]);

  await seedSheet(HP2, "Zero Week Tracker");
  await seedTab("hp2-pe", HP2, "PE-5", 0, true);
  await seedSnapshot("hp2-pe-s", "hp2-pe", "hp2a", [
    PE,
    ["Plow", "0", "500", "8/20/2026"], // last week's real production: 500 ft
  ]);
  // a dated tab with NO station columns — a log, not footage
  await seedTab("hp2-log", HP2, "Daily Log", 1, true);
  await seedSnapshot("hp2-log-s", "hp2-log", "hp2b", [
    ["Item", "Date Complete", "Note"],
    ["toolbox talk", "8/27/2026", "all crews"], // THIS week's newest date, 0 ft
  ]);

  await seedSheet(HP3, "Quiet Log Tracker");
  await seedTab("hp3-pe", HP3, "PE-6", 0, true);
  await seedSnapshot("hp3-pe-s", "hp3-pe", "hp3a", [
    PE,
    ["Plow", "0", "500", "8/27/2026"], // work completed 8/27
  ]);
  await seedTab("hp3-stop", HP3, "Work Stoppages", 1, false);
  await seedSnapshot("hp3-stop-s", "hp3-stop", "hp3b", [
    ["Date", "Description"],
    ["7/6/2026", "permit hold"], // 52 days behind — the guard fires
  ]);
});

const sheetNamed = (sheets: Awaited<ReturnType<typeof buildDigestSheets>>, title: string) => {
  const s = sheets.find((x) => x.title === title);
  if (!s) throw new Error(`sheet ${title} missing from digest`);
  return s;
};

describe("digest permit/stoppage highlights (the same detectors, the same deduped data)", () => {
  it("counts unapproved crossings and designed-no-permit packages from the tracker join", async () => {
    const sheets = await buildDigestSheets("u1", NOW);
    const hp1 = sheetNamed(sheets, "Highlight Tracker");
    expect(hp1.weekFt).toBe(900); // both shots land in the week of 8/17 — the join's week
    expect(hp1.permitCounts).toEqual({ unapprovedCrossings: 1, designedNoPermit: 1 });
  });

  it("annotates the digest week with the stoppage log — count + exemplar, no quiet nag when current", async () => {
    const sheets = await buildDigestSheets("u1", NOW);
    const hp1 = sheetNamed(sheets, "Highlight Tracker");
    expect(hp1.stoppage).toEqual({ weekCount: 1, exemplar: "waiting on utility locate", quietDaysBehind: null });
  });

  it("flags a stoppage log that trails the newest completed work by weeks", async () => {
    const sheets = await buildDigestSheets("u1", NOW);
    const hp3 = sheetNamed(sheets, "Quiet Log Tracker");
    expect(hp3.stoppage).toEqual({ weekCount: 0, exemplar: "", quietDaysBehind: 52 });
  });
});

describe("digest zero-week guard (a dated station-less tab must not zero this week)", () => {
  it("keeps last week's real footage as the headline instead of a 0-ft bucket from a log tab", async () => {
    const sheets = await buildDigestSheets("u1", NOW);
    const hp2 = sheetNamed(sheets, "Zero Week Tracker");
    // before the guard: the Daily Log's 0-ft 8/24 bucket was the newest week —
    // "this week 0 ft" (−500 WoW) while 500 ft sat in the prior bucket
    expect(hp2.weekFt).toBe(500);
    expect(hp2.weekDeltaFt).toBeNull(); // only one week of footage — no WoW to compute
    expect(hp2.permitCounts).toBeNull(); // no Permit Tracker — the join stays silent
    expect(hp2.stoppage).toBeNull(); // no stoppage log either
  });
});
