import { describe, expect, it } from "vitest";
import { computeFootage, detectStationColumns, parseStation, runChecks } from "./checks";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

describe("parseStation", () => {
  it("parses survey notation", () => {
    expect(parseStation("4+47")).toBe(447);
    expect(parseStation("164+82")).toBe(16482);
    // absurd magnitudes are not stations — two ~1e308 cells used to sum to
    // Infinity in the footage ledger
    expect(parseStation("1".repeat(309))).toBeNull();
    expect(parseStation("1000000000000")).toBeNull(); // 1e12 ft
    expect(parseStation("999999999")).toBe(999999999); // 1e9 still plausible
    expect(parseStation("267+18")).toBe(26718);
  });
  it("parses plain feet and tolerant formats", () => {
    expect(parseStation("15743")).toBe(15743);
    expect(parseStation("15,743")).toBe(15743);
    expect(parseStation("100 ft")).toBe(100);
    expect(parseStation("100.5")).toBe(100.5);
  });
  it("rejects non-stations", () => {
    expect(parseStation("")).toBeNull();
    expect(parseStation("bore")).toBeNull();
    expect(parseStation("US2-PE4")).toBeNull();
  });
});

describe("detectStationColumns", () => {
  it("finds start/end station headers", () => {
    const s = snap(
      ["Shot", "Start Station", "End Station", "Type"],
      [
        ["A", "0", "100", "plow"],
        ["B", "100", "250", "bore"],
      ],
    );
    expect(detectStationColumns(s)).toEqual({ start: 1, end: 2 });
  });
  it("falls back to generic station columns", () => {
    const s = snap(
      ["Shot", "Begin Sta", "Stop Sta"],
      [
        ["A", "0", "100"],
        ["B", "100", "250"],
      ],
    );
    expect(detectStationColumns(s)).toEqual({ start: 1, end: 2 });
  });
  it("returns null when no station columns exist", () => {
    const s = snap(["Crew", "Task"], [["Jake", "Framing"]]);
    expect(detectStationColumns(s)).toBeNull();
  });
});

describe("computeFootage", () => {
  it("sums footage across mixed station formats", () => {
    const s = snap(
      ["Shot", "Start Station", "End Station", "Type"],
      [
        ["S1", "4+47", "16+82", "plow"], // 1682 - 447 = 1235
        ["S2", "16+82", "15743", "bore"], // 15743 - 1682 = 14061
      ],
    );
    const f = computeFootage(s);
    expect(f.ft).toBe(1235 + 14061);
    expect(f.shots).toBe(2);
    expect(f.invalid).toBe(0);
    expect(f.stations).toEqual({ start: 1, end: 2 });
  });

  it("skips backwards and unreadable rows, counting them invalid", () => {
    const s = snap(
      ["Shot", "Start Station", "End Station"],
      [
        ["S1", "0", "500"],
        ["S2", "600", "100"], // backwards
        ["S3", "n/a", "900"], // unreadable
      ],
    );
    const f = computeFootage(s);
    expect(f.ft).toBe(500);
    expect(f.shots).toBe(1);
    expect(f.invalid).toBe(2);
  });

  it("returns zeros when no station columns exist", () => {
    const f = computeFootage(snap(["Crew", "Task"], [["Jake", "Framing"]]));
    expect(f.ft).toBe(0);
    expect(f.stations).toBeNull();
  });
});

describe("runChecks", () => {
  const chain = snap(
    ["Shot", "Start Station", "End Station", "Type"],
    [
      ["S1", "0", "500", "plow"],
      ["S2", "500", "14800", "bore"],
      ["S3", "14800", "15741", "plow"],
      ["S4", "15743", "16000", "plow"], // 2 ft gap before this row
    ],
  );

  it("flags footage gaps from a wrong ending station", () => {
    const findings = runChecks([{ tabTitle: "PE4", data: chain, keyColumn: 0 }]);
    const gap = findings.find((f) => f.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap!.message).toContain("2 ft unaccounted");
    expect(gap!.message).toContain("15,741–15,743");
  });

  it("flags overlaps", () => {
    const overlap = snap(
      ["Shot", "Start Station", "End Station"],
      [
        ["S1", "0", "500"],
        ["S2", "400", "600"], // starts before S1 ends
      ],
    );
    const findings = runChecks([{ tabTitle: "PE1", data: overlap, keyColumn: 0 }]);
    expect(findings.some((f) => f.kind === "overlap" && f.message.includes("100 ft"))).toBe(true);
  });

  it("is quiet on a clean chain", () => {
    const clean = snap(
      ["Shot", "Start Station", "End Station"],
      [
        ["S1", "0", "500"],
        ["S2", "500", "900"],
      ],
    );
    expect(runChecks([{ tabTitle: "PE1", data: clean, keyColumn: 0 }])).toEqual([]);
  });

  it("handles survey notation in the chain", () => {
    const mixed = snap(
      ["Shot", "Start Station", "End Station"],
      [
        ["S1", "4+47", "16+80"],
        ["S2", "16+80", "16+82"], // exactly continuous in survey notation
      ],
    );
    expect(runChecks([{ tabTitle: "PE1", data: mixed, keyColumn: 0 }])).toEqual([]);
  });

  it("flags exact duplicates on tiny tabs — dup detection is never gated by uniqueness", () => {
    const dup = snap(
      ["Activity", "Start STA", "End STA"],
      [
        ["GAP", "500", "620"],
        ["GAP", "500", "620"], // identical twin — the very case a uniqueness gate would hide
      ],
    );
    const findings = runChecks([{ tabTitle: "PE1", data: dup, keyColumn: null }]);
    expect(findings.some((f) => f.kind === "dupe-key")).toBe(true);
  });

  it("flags rows that run backwards", () => {
    const backwards = snap(
      ["Shot", "Start Station", "End Station"],
      [
        ["S1", "0", "500"],
        ["S2", "600", "100"], // start > end
      ],
    );
    const findings = runChecks([{ tabTitle: "PE1", data: backwards, keyColumn: 0 }]);
    expect(findings.some((f) => f.message.includes("runs backwards"))).toBe(true);
  });

  it("flags duplicate keys in one tab (bore + plow double entry)", () => {
    const dupes = snap(
      ["Shot", "Start Station", "End Station", "Type"],
      [
        ["S9", "0", "300", "bore"],
        ["S9", "0", "300", "plow"],
      ],
    );
    const findings = runChecks([{ tabTitle: "PE4", data: dupes, keyColumn: 0 }]);
    expect(findings.some((f) => f.kind === "dupe-key" && f.message.includes("2×"))).toBe(true);
  });

  it("flags the same shot in two tabs (PE6 vs PE7)", () => {
    const pe6 = snap(["Shot", "Start Station", "End Station"], [["S12", "0", "400"]]);
    const pe7 = snap(
      ["Shot", "Start Station", "End Station"],
      [
        ["S11", "0", "100"],
        ["S12", "100", "400"],
      ],
    );
    const findings = runChecks([
      { tabTitle: "PE6", data: pe6, keyColumn: 0 },
      { tabTitle: "PE7", data: pe7, keyColumn: 0 },
    ]);
    const cross = findings.find((f) => f.kind === "cross-tab");
    expect(cross).toBeDefined();
    expect(cross!.message).toContain("PE6 and PE7");
  });
});

describe("runChecks: oversized chain lists collapse (digest saturation)", () => {
  // the real 43-tab tracker's Line List produces ~950 overlap findings and
  // drowns the checks panel and digest; >10 of either collapses to one
  // honest summary that points at the gap report
  const H = ["Activity", "Start STA", "End STA", "Crew"];

  it("more than 10 overlaps collapse into one summary finding", () => {
    // 15 consecutive rows, each overlapping the previous by 100 ft
    const rows = Array.from({ length: 15 }, (_, i) => ["Plow", String(i * 100), String(i * 100 + 200), "C"]);
    const findings = runChecks([{ tabTitle: "LL", data: snap(H, rows), keyColumn: null }]);
    const overlaps = findings.filter((f) => f.kind === "overlap");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.message).toMatch(/14 overlaps totaling \d[\d,]* ft/);
    expect(overlaps[0]!.message).toContain("double-counts repeatedly");
  });

  it("more than 10 unaccounted holes collapse into one summary finding", () => {
    // 15 rows with 100-ft jumps between them
    const rows = Array.from({ length: 15 }, (_, i) => ["Plow", String(i * 200), String(i * 200 + 100), "C"]);
    const findings = runChecks([{ tabTitle: "LL", data: snap(H, rows), keyColumn: null }]);
    const gaps = findings.filter((f) => f.kind === "gap" && f.message.includes("unaccounted holes"));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.message).toContain("see the gap report");
  });

  it("10 or fewer stay itemized — small tabs keep their precise findings", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ["Plow", String(i * 100), String(i * 100 + 200), "C"]);
    const findings = runChecks([{ tabTitle: "LL", data: snap(H, rows), keyColumn: null }]);
    expect(findings.filter((f) => f.kind === "overlap").length).toBe(7); // one per boundary
  });
});

describe("runChecks: cross-tab collapse (compilation tabs)", () => {
  const H = ["Activity", "Start STA", "End STA", "Crew"];
  // 12 identities shared between the compilation tab and one working tab:
  // itemized would be 12 identical-shape findings naming the same two tabs
  const shared = Array.from({ length: 12 }, (_, i) => ["Plow", String(i * 100), String(i * 100 + 50), "C"]);
  const working = { tabTitle: "PE-6", data: snap(H, shared), keyColumn: null };
  const compilation = { tabTitle: "Line List", data: snap(H, shared), keyColumn: null };

  it("more than 10 shared identities collapse to one summary naming the pattern", () => {
    const findings = runChecks([working, compilation]);
    const cross = findings.filter((f) => f.kind === "cross-tab");
    expect(cross).toHaveLength(1);
    expect(cross[0]!.message).toContain("12 identities also appear in 1 other tab");
    expect(cross[0]!.message).toContain("compilation tab, or shots entered in two places");
  });

  it("a handful of shared identities stays itemized (the actionable case)", () => {
    const few = shared.slice(0, 2);
    const findings = runChecks([
      { tabTitle: "PE-6", data: snap(H, few), keyColumn: null },
      { tabTitle: "PE-7", data: snap(H, few), keyColumn: null },
    ]);
    const cross = findings.filter((f) => f.kind === "cross-tab");
    expect(cross).toHaveLength(2);
    expect(cross[0]!.message).toContain("should be in only one");
  });
});
