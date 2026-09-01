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
  invoiceStatus,
  dedupeTabData,
  sheetBillableNow,
  detectStoppageTab,
  isStoppageTabTitle,
  stoppageWeeks,
  quietStoppageLog,
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
    // NEVER silent rollover: month-name entries naming a day that month does
    // not have are unreadable, not next month (V8 parses "Feb 30 2026" to
    // Mar 2 — that mis-aged A/R by days and shifted weekly buckets)
    expect(parseCompletedDate("Feb 30 2026")).toBeNull();
    expect(parseCompletedDate("February 30, 2026")).toBeNull();
    expect(parseCompletedDate("Thu Feb 30 2026")).toBeNull();
    expect(parseCompletedDate("30 Feb 2026")).toBeNull();
    expect(parseCompletedDate("June 31 2026")).toBeNull();
    expect(parseCompletedDate("Sep 31, 2026")).toBeNull();
    // valid month-name forms still parse (including 3-letter + weekday + time)
    expect(parseCompletedDate("May 28 2026")?.toISOString().slice(0, 10)).toBe("2026-05-28");
    expect(parseCompletedDate("Thu May 28 2026 19:00:00")?.toISOString().slice(0, 10)).toBe("2026-05-28");
    expect(parseCompletedDate("Sept 5 2026")?.toISOString().slice(0, 10)).toBe("2026-09-05");
    expect(parseCompletedDate("28 May 2026")?.toISOString().slice(0, 10)).toBe("2026-05-28");
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
  it("fractional-station holes are DISTINCT identities, never rounded together", () => {
    const day = 86_400_000;
    const now = 10 * day;
    const gapAt = (from: number, to: number) => computeGapReport(
      snap(["Activity", "Start STA", "End STA"], [
        ["Plow", "0", String(from)],
        ["Plow", String(to), "2000"],
      ]),
    );
    // 101.5-203.25 and 101-203 are different holes; the rounded key used to
    // merge them and drop one from the aging report
    const aged = agingGaps(
      [
        { createdAt: 2 * day, report: gapAt(101.5, 203.25) },
        { createdAt: 5 * day, report: gapAt(101.5, 203.25) },
      ],
      now,
    );
    expect(aged).toHaveLength(1);
    expect(aged[0]!.ft).toBeCloseTo(101.75, 6);
  });

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

describe("invoiceStatus (the office's own billing ledger)", () => {
  const H = ["Activity", "Start STA", "End STA", "Date Complete", "Entered in InEight", "Invoice #", "Bore log in GIS"];
  const NOW = new Date("2026-08-30T12:00:00").getTime();
  const mk = (a: string, s: string, e: string, c: string, ent: string, inv: string, gis: string) =>
    [a, s, e, c, ent, inv, gis];

  it("billable-now: completed + in-GIS + never entered, aged by Date Complete", () => {
    const data = snap(H, [
      mk("Plow", "0", "500", "2026-08-29", "", "", "Yes"), // 1d — billable
      mk("Bore", "500", "14800", "2026-07-01", "", "", "Yes"), // 60d — oldest
      mk("Plow", "14800", "15743", "2026-08-20", "", "", ""), // GIS not done — excluded
      mk("Plow", "20000", "20500", "2026-08-25", "2026-08-26", "", "Yes"), // entered — excluded
    ]);
    const st = invoiceStatus(data, NOW);
    expect(st.billableNow).toHaveLength(2);
    expect(st.oldestAgeDays).toBeGreaterThanOrEqual(59);
    expect(st.billableFt).toBe(500 + 14300);
    expect(st.enteredColumn).toBe("Entered in InEight");
    expect(st.invoiceColumn).toBe("Invoice #");
  });

  it("billed ledger + missed runs: numeric invoice numbers counted, past-month markers flagged", () => {
    const data = snap(H, [
      mk("Plow", "0", "500", "2026-08-01", "3103", "", "Yes"),
      mk("Bore", "500", "1000", "2026-08-02", "3103", "", "Yes"),
      mk("Plow", "1000", "1500", "2026-07-20", "August", "", "Yes"), // queued for August
      mk("Plow", "1500", "2000", "2026-06-15", "July", "", "Yes"), // July run already happened
    ]);
    const st = invoiceStatus(data, NOW);
    expect(st.billedByInvoice.find((x) => x.invoice === "3103")?.rows).toBe(2);
    expect(st.billedByInvoice.find((x) => x.invoice === "queued: August")?.rows).toBe(1);
    expect(st.missedRun).toEqual([{ invoice: "July", rows: 1 }]);
    expect(st.billableNow).toHaveLength(0);
  });

  it("no-ops without the entered column", () => {
    const data = snap(["Activity", "Start STA", "End STA"], [["Plow", "0", "500"]]);
    expect(invoiceStatus(data, NOW).enteredColumn).toBeNull();
  });

  it("month markers are year-aware: December viewed in January is a MISSED run (bare month indices read it queued)", () => {
    const jan = new Date("2026-01-15T12:00:00").getTime();
    const data = snap(H, [
      mk("Plow", "0", "500", "2025-12-01", "December", "", "Yes"), // run passed last month — missed
      mk("Bore", "500", "1000", "2025-11-15", "November", "", "Yes"), // 2 months back — missed
      mk("Plow", "1000", "1500", "2025-12-28", "February", "", "Yes"), // next month pre-queued — queued
      mk("Plow", "1500", "2000", "2026-01-02", "January", "", "Yes"), // current month's run — queued
    ]);
    const st = invoiceStatus(data, jan);
    expect(st.missedRun.map((m) => m.invoice).sort()).toEqual(["December", "November"]);
    expect(st.billedByInvoice.find((x) => x.invoice === "queued: February")?.rows).toBe(1);
    expect(st.billedByInvoice.find((x) => x.invoice === "queued: January")?.rows).toBe(1);
    expect(st.billableNow).toHaveLength(0);
  });

  it("a January marker typed in December is next year's queued run, not a forgotten one", () => {
    const dec = new Date("2026-12-15T12:00:00").getTime();
    const data = snap(H, [
      mk("Plow", "0", "500", "2026-11-20", "January", "", "Yes"), // 11 months back = next month's run — queued
      mk("Bore", "500", "1000", "2026-12-01", "October", "", "Yes"), // 2 months back — missed
    ]);
    const st = invoiceStatus(data, dec);
    expect(st.missedRun).toEqual([{ invoice: "October", rows: 1 }]);
    expect(st.billedByInvoice.find((x) => x.invoice === "queued: January")?.rows).toBe(1);
  });

  it("unparseable stations are skipped, not null-coerced (a junk start used to report the whole end station as billable ft)", () => {
    const data = snap(H, [
      mk("Bore", "\t-CR led bore", "2200", "2026-08-01", "", "", "Yes"), // start doesn't parse — NOT 2,200 ft
      mk("Plow", "0", "500", "2026-08-02", "", "", "Yes"), // measurable — 500 ft
    ]);
    const st = invoiceStatus(data, NOW);
    expect(st.billableNow).toHaveLength(1);
    expect(st.billableNow[0]!.ft).toBe(500);
    expect(st.billableFt).toBe(500);
  });

  it("an Invoice # alone (entered blank) is definitionally billed — ledger, never billable-now", () => {
    const data = snap(H, [
      mk("Plow", "0", "500", "2026-08-01", "", "3118", "Yes"), // invoice number only
      mk("Bore", "500", "1000", "2026-08-02", "", "August", "Yes"), // month marker in Invoice #
    ]);
    const st = invoiceStatus(data, NOW);
    expect(st.billableNow).toHaveLength(0);
    expect(st.billableFt).toBe(0);
    expect(st.billedByInvoice.find((x) => x.invoice === "3118")?.rows).toBe(1);
    expect(st.billedByInvoice.find((x) => x.invoice === "queued: August")?.rows).toBe(1);
  });

  it("7-digit invoice numbers land in the billed ledger (3–6 digits used to let them silently vanish)", () => {
    const data = snap(H, [mk("Plow", "0", "500", "2026-08-01", "1234567", "", "Yes")]);
    expect(invoiceStatus(data, NOW).billedByInvoice).toEqual([{ invoice: "1234567", rows: 1 }]);
  });

  it("an explicit no/n-a in the GIS column blocks billing; other values and a missing column pass", () => {
    const data = snap(H, [
      mk("Plow", "0", "100", "2026-08-01", "", "", "NO"), // explicitly not in GIS — blocked
      mk("Bore", "100", "200", "2026-08-01", "", "", "n/a"), // blocked
      mk("Plow", "200", "300", "2026-08-01", "", "", "not yet"), // blocked
      mk("Plow", "300", "400", "2026-08-01", "", "", "8/28/26"), // a date stamp means done — billable
    ]);
    const st = invoiceStatus(data, NOW);
    expect(st.billableNow).toHaveLength(1);
    expect(st.billableFt).toBe(100);
    // no GIS column at all: absence of the check can't block billing
    const H2 = ["Activity", "Start STA", "End STA", "Date Complete", "Entered in InEight"];
    const st2 = invoiceStatus(snap(H2, [["Plow", "0", "100", "2026-08-01", ""]]), NOW);
    expect(st2.billableNow).toHaveLength(1);
  });
});

describe("dedupeTabData (compilation tabs copy working tabs)", () => {
  const HEAD = ["Activity", "Start STA", "End STA", "Crew"];
  const row = ["Plow", "0", "500", "CREW A"];

  it("counts each identical row once across tabs; blank padding ignored; first tab wins", () => {
    const out = dedupeTabData([
      { title: "PE-4", data: snap(HEAD, [row, ["", "", "", ""]]) },
      { title: "Line List", data: snap(HEAD, [row, row, ["Bore", "500", "14800", "CREW B"]]) },
    ]);
    // position-preserving: blank padding keeps its slot, copied rows are
    // blanked IN PLACE so "Row N" stays the sheet's true row number
    expect(out.freshByTab.get("PE-4")).toEqual([row, ["", "", "", ""]]);
    expect(out.freshByTab.get("Line List")).toEqual([["", "", "", ""], ["", "", "", ""], ["Bore", "500", "14800", "CREW B"]]);
    expect(out.duplicatesDropped).toBe(2);
    expect(out.pureCopies.size).toBe(0);
  });

  it("names a tab whose every non-blank row is a copy as a pure compilation tab", () => {
    const out = dedupeTabData([
      { title: "PE-4", data: snap(HEAD, [row]) },
      { title: "PE7", data: snap(HEAD, [row, ["", "", "", ""], ["", "", "", ""]]) },
    ]);
    expect(out.pureCopies).toEqual(new Set(["PE7"]));
    expect(out.freshByTab.get("PE7")).toEqual([["", "", "", ""], ["", "", "", ""], ["", "", "", ""]]);
    // an all-blank tab is EMPTY, not a copy — callers may still read its headers
    const blank = dedupeTabData([{ title: "Blank", data: snap(HEAD, [["", "", "", ""]]) }]);
    expect(blank.pureCopies.size).toBe(0);
  });

  it("a mixed tab keeps its own fresh rows while the copies drop", () => {
    const out = dedupeTabData([
      { title: "PE-4", data: snap(HEAD, [row]) },
      { title: "PE-5", data: snap(HEAD, [row, ["Bore", "500", "900", "CREW B"]]) },
    ]);
    expect(out.freshByTab.get("PE-5")).toEqual([["", "", "", ""], ["Bore", "500", "900", "CREW B"]]);
    expect(out.duplicatesDropped).toBe(1);
    expect(out.pureCopies.size).toBe(0);
  });
});

describe("sheetBillableNow (the badge must equal the billing dashboard's number)", () => {
  const BH = ["Activity", "Start STA", "End STA", "Date Complete", "Bore Log in GIS?", "Entered in InEight"];
  const NOW = Date.UTC(2026, 7, 30);
  const billable = ["Bore", "500", "900", "2026-08-20", "Yes", ""];

  it("sums billable rows across tabs but never counts a copy tab twice", () => {
    const tabs = [
      { title: "PE-4", data: snap(BH, [billable, ["Plow", "0", "500", "2026-08-19", "", "7/1/2026"]]) },
      { title: "PE7", data: snap(BH, [billable]) }, // pure copy of PE-4's billable row
      { title: "PE-5", data: snap(BH, [["Bore", "0", "300", "2026-08-21", "Yes", ""]]) }, // its own
    ];
    expect(sheetBillableNow(tabs, NOW)).toBe(2); // 1 (PE-4) + 1 (PE-5) — the copy adds nothing
  });

  it("returns 0 when no tab tracks an office ledger (feature no-ops)", () => {
    expect(sheetBillableNow([{ title: "PE-4", data: snap(H, [["Plow", "0", "500", "2026-08-19", "A"]]) }], NOW)).toBe(0);
  });
});

describe("stoppage join (weekly report explains quiet weeks)", () => {
  const SH = ["Date", "Description"];
  const PH = ["Activity", "Start STA", "End STA", "Date Complete"];

  it("detects a stoppage tab by title AND Date/Description headers", () => {
    const stoppage = { title: "Work Stoppages", data: snap(SH, []) };
    expect(detectStoppageTab([stoppage])).toBe(stoppage);
    expect(detectStoppageTab([{ title: "Work Stoppages", data: snap(["Permit", "Status"], []) }])).toBeNull(); // no dated log
    expect(detectStoppageTab([{ title: "PE-4", data: snap(SH, []) }])).toBeNull(); // wrong tab entirely
    expect(isStoppageTabTitle("Daily stoppage log")).toBe(true);
    expect(isStoppageTabTitle("PE-4")).toBe(false);
  });

  it("buckets stoppages into the same Monday buckets weeklyProduction uses", () => {
    // 8/20/2026 is a Thursday -> Monday 8/17; 8/24 is the NEXT Monday
    const weeks = stoppageWeeks(snap(SH, [
      ["8/20/2026", "utility locate late"],
      ["8/21/2026", "rock"],
      ["8/24/2026", ""], // blank reason still counts as a logged day
      ["not a date", "never bucketed"],
    ]));
    expect(weeks.size).toBe(2);
    const wk1 = weeks.get(new Date(2026, 7, 17).getTime())!;
    expect(wk1.count).toBe(2);
    expect(wk1.exemplar).toBe("utility locate late");
    const wk2 = weeks.get(new Date(2026, 7, 24).getTime())!;
    expect(wk2.count).toBe(1);
    // the same rows land in weeklyProduction's buckets for the same Mondays
    const prod = weeklyProduction(snap(PH, [["Plow", "0", "500", "8/20/2026"]]));
    expect(prod[0]!.weekStart).toBe(wk1.weekStart);
  });

  it("quiet-log guard fires only when the log trails the work by weeks", () => {
    const weeks = stoppageWeeks(snap(SH, [["7/6/2026", "waiting on permit"]]));
    const current = [snap(PH, [["Plow", "0", "500", "7/10/2026"]])];
    expect(quietStoppageLog(weeks, current)).toBeNull(); // 4 days behind — kept current
    const stale = [snap(PH, [["Plow", "0", "500", "8/26/2026"]])];
    const q = quietStoppageLog(weeks, stale)!; // 7 weeks behind
    expect(q.daysBehind).toBeGreaterThan(40);
    expect(q.newestStoppage).toBe("2026-07-06");
    expect(q.newestCompletion).toBe("8/26/2026");
    expect(quietStoppageLog(new Map(), stale)).toBeNull(); // no log at all — nothing to judge
  });

  it("widened date headers: 'Date of Stoppage', 'Stop Date' etc. still evidence-gate the join", () => {
    const variants = [
      ["Date of Stoppage", "Description"],
      ["Stop Date", "Reason"],
      ["Stoppage Date", "Notes"],
      ["Date Stopped", "Cause"],
    ];
    for (const headers of variants) {
      const t = { title: "Work Stoppages", data: snap(headers, [["8/20/2026", "utility locate late"]]) };
      expect(detectStoppageTab([t])).toBe(t); // title + Date + Description vocabulary
      const weeks = stoppageWeeks(t.data);
      expect(weeks.get(new Date(2026, 7, 17).getTime())?.count).toBe(1); // 8/20 buckets into week of 8/17
    }
    // production vocabulary must NOT activate the join: "Date Complete" is a
    // placed-footage column, not a log date
    expect(
      detectStoppageTab([{ title: "Work Stoppages", data: snap(["Date Complete", "Description"], []) }]),
    ).toBeNull();
  });

  it("quiet-log guard measures the newest ENTRY date, not the Monday bucket", () => {
    // a log kept Friday 8/21 (bucket Monday 8/17) against work completed 8/27:
    // 6 days behind by entry date — bucket math claimed 10
    const weeks = stoppageWeeks(snap(SH, [
      ["8/19/2026", "rock"],
      ["8/21/2026", "waiting on permit"], // newest entry in the same bucket
    ]));
    const prod = [snap(PH, [["Plow", "0", "500", "8/27/2026"]])];
    expect(quietStoppageLog(weeks, prod)).toBeNull(); // 6 days — current, no nag
    // pushed past the 14-day tolerance from the SAME bucket: entry date decides
    const stale = stoppageWeeks(snap(SH, [["8/21/2026", "waiting on permit"]]));
    const q = quietStoppageLog(stale, [snap(PH, [["Plow", "0", "500", "9/8/2026"]])], 10)!;
    expect(q.daysBehind).toBe(18); // 8/21 -> 9/8, not 8/17 -> 9/8 (22)
    expect(q.newestStoppage).toBe("2026-08-21"); // the entry, not its Monday
  });
});
