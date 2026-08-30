import { describe, it, expect } from "vitest";
import {
  parseCompletedDate,
  dateHygiene,
  detectLateEntries,
  reconcileTotals,
  computeCrewBoard,
  agingGaps,
} from "./production";
import { computeGapReport } from "./gaps";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });
const H = ["Activity", "Start STA", "End STA", "Date Complete", "Crew #"];

describe("parseCompletedDate", () => {
  it("parses the formats crews type", () => {
    expect(parseCompletedDate("2026-07-14")?.toISOString().slice(0, 10)).toBe("2026-07-14");
    expect(parseCompletedDate("7/14/2026")?.getFullYear()).toBe(2026);
    expect(parseCompletedDate("7/14")?.getMonth()).toBe(6); // year defaults to current
    expect(parseCompletedDate("Thu May 28 2026 19:00:00")?.getMonth()).toBe(4);
    expect(parseCompletedDate("")).toBeNull();
    expect(parseCompletedDate("TBD")).toBeNull();
    expect(parseCompletedDate("US2-PE-004")).toBeNull();
  });
});

describe("dateHygiene", () => {
  it("flags undated, unreadable, and future-dated placed footage", () => {
    const today = new Date("2026-08-30T12:00:00");
    const rows = [
      ["Plow", "0", "500", "8/28/2026", "A"],   // fine
      ["Bore", "500", "900", "", "B"],           // undated
      ["Plow", "900", "1200", "sometime", "A"],  // unreadable
      ["Bore", "1200", "1500", "12/25/2026", "C"], // future
      ["48 Handhole", "500", "500", "", "B"],    // not footage — ignored
    ];
    const f = dateHygiene(snap(H, rows), today);
    expect(f.map((x) => x.kind)).toEqual(["undated", "unreadable", "future"]);
    expect(f[0]!.row).toBe(2);
  });
});

describe("detectLateEntries", () => {
  it("flags work dated long before the snapshot that first showed it", () => {
    const monday = new Date(2026, 6, 13, 18).getTime(); // local, like real captures
    const thursday = new Date(2026, 6, 16, 18).getTime();
    const walk = [
      { createdAt: monday, data: snap(H, [["Plow", "0", "500", "7/13/2026", "A"]]) },
      { createdAt: thursday, data: snap(H, [
        ["Plow", "0", "500", "7/13/2026", "A"],
        ["Plow", "500", "1300", "7/13/2026", "A"], // 800 ft dated Monday, appearing Thursday
      ]) },
    ];
    const late = detectLateEntries(walk);
    expect(late).toHaveLength(1);
    expect(late[0]!.daysLate).toBe(3); // Monday-dated work appearing Thursday
    expect(late[0]!.activity).toBe("Plow");
  });

  it("does not flag next-day entry of same-day work", () => {
    const t1 = new Date("2026-07-13T18:00:00").getTime();
    const t2 = new Date("2026-07-14T08:00:00").getTime();
    const walk = [
      { createdAt: t1, data: snap(H, []) },
      { createdAt: t2, data: snap(H, [["Plow", "0", "500", "7/13/2026", "A"]]) },
    ];
    expect(detectLateEntries(walk)).toEqual([]); // 14h < 2-day tolerance
  });
});

describe("reconcileTotals", () => {
  it("flags TOTALS rows that disagree with the tab's own math", () => {
    const totals = snap(
      ["Permit Package", "Drawing", "Designed Footage"],
      [
        ["US2-PE-001", "US2-DR-001", "5000"],
        ["US2-PE-002", "US2-DR-002", "1200"], // tab adds up to 1000
      ],
    );
    const perTab = new Map([
      ["us2-pe-001", 5000],
      ["us2-pe-002", 1000],
    ]);
    const mismatches = reconcileTotals(totals, perTab);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ tabTitle: "us2-pe-002", totalsSays: 1200, tabAddsUp: 1000, delta: 200 });
  });

  it("is quiet when they agree", () => {
    const totals = snap(["PE", "Ft"], [["US2-PE-001", "5000"]]);
    expect(reconcileTotals(totals, new Map([["us2-pe-001", 5000]]))).toEqual([]);
  });
});

describe("computeCrewBoard", () => {
  it("groups footage by crew and day with a reconciliation row", () => {
    const rows = [
      ["Plow", "0", "500", "8/28/2026", "BIG M P1"],
      ["Plow", "500", "900", "8/28/2026", "BIG M P1"],
      ["Bore", "900", "1200", "8/29/2026", "HAIDER 1"],
      ["Plow", "1200", "1300", "", ""], // uncategorized, undated
    ];
    const b = computeCrewBoard(snap(H, rows));
    const bigm = b.crews.find((c) => c.crew === "BIG M P1")!;
    expect(bigm.ft).toBe(900);
    expect(bigm.days).toBe(1);
    expect(b.crews.find((c) => c.crew === "HAIDER 1")!.ft).toBe(300);
    expect(b.uncategorizedFt).toBe(100);
    expect(b.days.find((d) => d.crew === "BIG M P1" && d.date === "2026-08-28")!.ft).toBe(900);
  });
});

describe("agingGaps", () => {
  it("ages open holes by station-range identity and drops closed ones", () => {
    const day = 86_400_000;
    const now = 10 * day;
    const gapAt = (from: number, to: number) => computeGapReport(
      snap(["Activity", "Start STA", "End STA"], [
        ["Plow", "0", String(from)],
        ["Plow", String(to), "2000"],
      ]),
    );
    const reports = [
      { createdAt: 2 * day, report: gapAt(500, 620) }, // hole opens day 2
      { createdAt: 5 * day, report: gapAt(500, 620) }, // still open day 5
      { createdAt: 8 * day, report: { ...gapAt(0, 0), unaccounted: [] } }, // closed day 8
    ];
    const aged = agingGaps(reports, now);
    expect(aged).toHaveLength(0); // closed holes aren't listed

    const stillOpen = [
      { createdAt: 2 * day, report: gapAt(500, 620) },
      { createdAt: 5 * day, report: gapAt(500, 620) },
    ];
    const aged2 = agingGaps(stillOpen, now);
    expect(aged2).toHaveLength(1);
    expect(aged2[0]!.daysOpen).toBe(8);
    expect(aged2[0]!.ft).toBe(120);
  });
});
