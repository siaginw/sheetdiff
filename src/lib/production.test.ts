import { describe, it, expect } from "vitest";
import {
  parseCompletedDate,
  dateHygiene,
  detectLateEntries,
  reconcileTotals,
  detectOverplacement,
  computeCrewBoard,
  agingGaps,
  officePipeline,
  weeklyProduction,
  aggregateWeekly,
} from "./production";
import type { WeekBucket } from "./production";
import { computeGapReport } from "./gaps";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });
const H = ["Activity", "Start STA", "End STA", "Date Complete", "Crew #"];

describe("parseCompletedDate", () => {
  it("parses the formats crews type", () => {
    expect(parseCompletedDate("2026-07-14")?.toISOString().slice(0, 10)).toBe("2026-07-14");
    expect(parseCompletedDate("7/14/2026")?.getFullYear()).toBe(2026);
    expect(parseCompletedDate("7/14")?.getMonth()).toBe(6); // year defaults to current
    expect(parseCompletedDate("14/07/2026")).toBeNull(); // day-first: month 14 is NOT a rollover
    expect(parseCompletedDate("6/31/26")).toBeNull(); // June has 30 days, not a silent July 1
    expect(parseCompletedDate("9999-99-99")).toBeNull();
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
      ["GAP", "1500", "1620", "", "C"],          // booked hole — never counted
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

  it("a row EDITED later is not late — only first appearance counts", () => {
    const t1 = new Date(2026, 6, 13, 18).getTime();
    const t2 = new Date(2026, 6, 20, 18).getTime();
    const walk = [
      { createdAt: t1, data: snap(H, [["Plow", "0", "500", "7/13/2026", "CREW A"]]) },
      { createdAt: t2, data: snap(H, [["Plow", "0", "500", "7/13/2026", "CREW A (fixed)"]]) },
    ];
    expect(detectLateEntries(walk)).toEqual([]); // supervisor fixed the crew name — not backdated
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
  it("uses the header-guided placed column, not the first numeric", () => {
    // real-tracker shape: [PE, Drawing, Plow ft, ..., Total Conduit Placed]
    const totals = snap(
      ["Permit Package", "Drawing Number", "Plow/ Trench", "Total Conduit Placed"],
      [
        ["US2-PE-001", "US1-DR-001", "23044", "25662"], // placed matches; Plow col differs (would false-fire on first-numeric)
        ["US2-PE-002", "US1-DR-002", "38358", "52994"], // placed differs by 296
      ],
    );
    const perTab = new Map([
      ["us2-pe-001", { title: "US2-PE-001", ft: 25662 }],
      ["us2-pe-002", { title: "US2-PE-002", ft: 52698 }],
    ]);
    const m = reconcileTotals(totals, perTab);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tabTitle: "US2-PE-002", totalsSays: 52994, tabAddsUp: 52698 });
  });

  it("agrees when ANY numeric cell is within tolerance (drawing numbers etc.)", () => {
    const totals = snap(["PE", "Drawing", "Placed"], [["US2-PE-002", "1102", "1000"]]);
    expect(reconcileTotals(totals, new Map([["us2-pe-002", { title: "US2-PE-002", ft: 1000 }]]))).toEqual([]);
  });

  it("skips not-started tabs (blank placed cell) and returns real-case titles", () => {
    const totals = snap(["PE", "Total Conduit Placed"], [
      ["US2-PE-003", ""],       // not started
      ["US2-PE-004", "9999"],   // real mismatch
    ]);
    const m = reconcileTotals(totals, new Map([
      ["us2-pe-003", { title: "US2-PE-003", ft: 0 }],
      ["us2-pe-004", { title: "US2-PE-004", ft: 9000 }],
    ]));
    expect(m).toHaveLength(1);
    expect(m[0]!.tabTitle).toBe("US2-PE-004"); // real case, not the lowercase key
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

  it("collapses hand-spellings of one crew; displays the most-typed spelling + how many variants merged", () => {
    const rows = [
      ["Plow", "0", "100", "8/28/2026", "BIG M DRILL 1"],
      ["Plow", "100", "250", "8/28/2026", "BIGM DRILL1"],
      ["Plow", "250", "400", "8/28/2026", "BIG M DRILL 1"], // the spelling they actually type most
      ["Plow", "400", "450", "8/28/2026", "big m drill 1"],
    ];
    const b = computeCrewBoard(snap(H, rows));
    expect(b.crews).toHaveLength(1);
    const bigm = b.crews[0]!;
    expect(bigm.crew).toBe("BIG M DRILL 1"); // most frequent, not first-seen
    expect(bigm.ft).toBe(450); // all four fragments sum into one crew
    expect(bigm.spellings).toBe(3);
    expect(bigm.days).toBe(1);
    expect(b.days.every((d) => d.crew === "BIG M DRILL 1")).toBe(true);
  });

  it("keeps genuinely different crews apart; blank crew is uncategorized, not a phantom crew", () => {
    const rows = [
      ["Plow", "0", "100", "8/28/2026", "HAIDER 1"],
      ["Plow", "100", "200", "8/28/2026", "HAIDER 2"],
      ["Plow", "200", "300", "8/28/2026", ""],
    ];
    const b = computeCrewBoard(snap(H, rows));
    expect(b.crews.map((c) => c.crew).sort()).toEqual(["HAIDER 1", "HAIDER 2"]);
    expect(b.uncategorizedFt).toBe(100);
  });
});

describe("detectOverplacement", () => {
  const totals = snap(
    ["Permit Package", "Total Conduit Designed", "Plow/ Trench", "Total Conduit Placed"],
    [
      ["US2-PE-001", "25662", "23044", "25662"], // placed == designed — fine
      ["US2-PE-002", "52041", "38358", "52994"], // 953 ft nobody designed (real-tracker case)
      ["US2-PE-003", "", "0", ""],               // not started — nothing to judge
      ["US2-PE-004", "52698", "12000", "52698"], // exact — fine
    ],
  );

  it("flags packages where TOTALS says Placed exceeds Designed", () => {
    const o = detectOverplacement(totals);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ tabTitle: "US2-PE-002", designed: 52041, placed: 52994, overBy: 953 });
  });

  it("never guesses: a missing Designed (or Placed) column means no findings", () => {
    expect(detectOverplacement(snap(["PE", "Total Conduit Placed"], [["US2-PE-001", "100"]]))).toEqual([]);
    expect(detectOverplacement(snap(["PE", "Total Conduit Designed"], [["US2-PE-001", "100"]]))).toEqual([]);
  });

  it("tolerance absorbs rounding noise but not real over-placement", () => {
    const t = snap(["PE", "Designed", "Placed"], [["US2-PE-005", "1000", "1000.5"]]);
    expect(detectOverplacement(t)).toEqual([]);
    expect(detectOverplacement(t, 0)).toHaveLength(1);
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

  it("a hole that closes then REOPENS ages from the reopen, never vanishes", () => {
    const day = 86_400_000;
    const now = 10 * day;
    const gapAt2 = (from: number, to: number) => computeGapReport(
      snap(["Activity", "Start STA", "End STA"], [["Plow", "0", String(from)], ["Plow", String(to), "2000"]]),
    );
    const reports = [
      { createdAt: 1 * day, report: gapAt2(500, 620) },
      { createdAt: 2 * day, report: { ...gapAt2(0, 0), unaccounted: [] } }, // closed
      { createdAt: 6 * day, report: gapAt2(500, 620) },                     // REOPENED
    ];
    const aged = agingGaps(reports, now);
    expect(aged).toHaveLength(1); // the ledger's whole job: it is open RIGHT NOW
    expect(aged[0]!.daysOpen).toBe(4); // aged from the reopen, not the original sighting
  });
});

describe("officePipeline (the sheet's own entered-downstream column)", () => {
  const H = ["Activity", "Start STA", "End STA", "Date Complete", "Entered in InEight"];
  const NOW = new Date("2026-08-30T12:00:00").getTime();

  it("buckets completed-but-unentered rows by age and no-ops without the column", () => {
    const mk = (completed: string, entered: string) => ["Plow", "0", "500", completed, entered];
    const data = snap(H, [
      mk("2026-08-29", "2026-08-30"), // entered — excluded
      mk("2026-08-29", ""), // 1d — normal
      mk("2026-08-26", ""), // 4d — aging
      mk("2026-07-11", ""), // 50d — stuck
      ["GAP", "500", "620", "2026-08-29", ""], // gap row — not office work
      ["Plow", "620", "700", "", ""], // not complete yet
    ]);
    const p = officePipeline(data, NOW);
    expect(p.enteredColumn).toBe("Entered in InEight");
    expect(p.normal).toHaveLength(1);
    expect(p.aging).toHaveLength(1);
    expect(p.stuck).toHaveLength(1);
    expect(p.stuck[0]!.daysWaiting).toBeGreaterThanOrEqual(49);
    expect(p.stuck[0]!.completedOn).toBe("2026-07-11");
    // no entered column → silent no-op
    const plain = snap(["Activity", "Start STA", "End STA", "Date Complete", "Notes"], [["Plow", "0", "500", "2026-08-29", "x"]]);
    plain.headers = ["Activity", "Start STA", "End STA", "Date Complete", "Notes"];
    expect(officePipeline(plain, NOW).enteredColumn).toBeNull();
  });
});

describe("weeklyProduction (footage per week, as dated)", () => {
  it("buckets by Monday of Date Complete; adders/gaps/handholes excluded", () => {
    const H = ["Activity", "Start STA", "End STA", "Date Complete"];
    const data = snap(H, [
      ["Plow", "0", "500", "2026-08-25"], // Tue Aug 25 — week of Mon Aug 24
      ["Bore", "500", "14800", "2026-08-27"], // same week: +14300
      ["Plow", "14800", "15743", "2026-08-18"], // week of Aug 17
      ["Cobble Adder", "500", "600", "2026-08-26"], // adder — excluded
      ["GAP", "600", "700", "2026-08-26"], // gap — excluded
      ["48 Handhole", "700", "700", "2026-08-26"], // zero-length — excluded
      ["Plow", "20000", "20500", ""], // undated — excluded
    ]);
    const weeks = weeklyProduction(data);
    expect(weeks).toHaveLength(2);
    const w1 = weeks.find((w) => new Date(w.weekStart).getDate() === 17);
    const w2 = weeks.find((w) => new Date(w.weekStart).getDate() === 24);
    expect(w1?.ft).toBe(943);
    expect(w2?.ft).toBe(500 + 14300);
    expect(w2?.shots).toBe(2);
    // weekStart is a Monday
    expect(new Date(weeks[0]!.weekStart).getDay()).toBe(1);
  });

  it("returns [] without a date column", () => {
    const data = snap(["Activity", "Start STA", "End STA"], [["Plow", "0", "500"]]);
    expect(weeklyProduction(data)).toEqual([]);
  });
});

describe("aggregateWeekly (the report page's math)", () => {
  const W = (weekStart: number, ft: number, shots = 1): WeekBucket => ({ weekStart, ft, shots });
  it("merges tabs on the same week and sums placed; weeks ascending", () => {
    const r = aggregateWeekly([
      { weeks: [W(1000, 500), W(2000, 300)], placedFt: 800 },
      { weeks: [W(1000, 200), W(3000, 50)], placedFt: 250 },
    ]);
    expect(r.placedFt).toBe(1050);
    expect(r.weeks.map((w) => w.weekStart)).toEqual([1000, 2000, 3000]);
    expect(r.weeks[0]!.ft).toBe(700); // merged across tabs
    expect(r.weeks[0]!.shots).toBe(2);
  });

  it("empty tabs aggregate to nothing", () => {
    expect(aggregateWeekly([])).toEqual({ weeks: [], placedFt: 0 });
  });
});
