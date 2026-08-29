import { describe, it, expect } from "vitest";
import { parseStation, detectStationColumns, runChecks } from "./checks";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

describe("parseStation", () => {
  it("parses survey notation", () => {
    expect(parseStation("4+47")).toBe(447);
    expect(parseStation("164+82")).toBe(16482);
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
    const s = snap(["Shot", "Start Station", "End Station", "Type"], [
      ["A", "0", "100", "plow"],
      ["B", "100", "250", "bore"],
    ]);
    expect(detectStationColumns(s)).toEqual({ start: 1, end: 2 });
  });
  it("falls back to generic station columns", () => {
    const s = snap(["Shot", "Begin Sta", "Stop Sta"], [
      ["A", "0", "100"],
      ["B", "100", "250"],
    ]);
    expect(detectStationColumns(s)).toEqual({ start: 1, end: 2 });
  });
  it("returns null when no station columns exist", () => {
    const s = snap(["Crew", "Task"], [["Jake", "Framing"]]);
    expect(detectStationColumns(s)).toBeNull();
  });
});

describe("runChecks", () => {
  const chain = snap(["Shot", "Start Station", "End Station", "Type"], [
    ["S1", "0", "500", "plow"],
    ["S2", "500", "14800", "bore"],
    ["S3", "14800", "15741", "plow"],
    ["S4", "15743", "16000", "plow"], // 2 ft gap before this row
  ]);

  it("flags footage gaps from a wrong ending station", () => {
    const findings = runChecks([{ tabTitle: "PE4", data: chain, keyColumn: 0 }]);
    const gap = findings.find((f) => f.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap!.message).toContain("2 ft gap");
    expect(gap!.rows).toEqual([3, 4]);
  });

  it("flags overlaps", () => {
    const overlap = snap(["Shot", "Start Station", "End Station"], [
      ["S1", "0", "500"],
      ["S2", "400", "600"], // starts before S1 ends
    ]);
    const findings = runChecks([{ tabTitle: "PE1", data: overlap, keyColumn: 0 }]);
    expect(findings.some((f) => f.kind === "overlap" && f.message.includes("100 ft"))).toBe(true);
  });

  it("is quiet on a clean chain", () => {
    const clean = snap(["Shot", "Start Station", "End Station"], [
      ["S1", "0", "500"],
      ["S2", "500", "900"],
    ]);
    expect(runChecks([{ tabTitle: "PE1", data: clean, keyColumn: 0 }])).toEqual([]);
  });

  it("handles survey notation in the chain", () => {
    const mixed = snap(["Shot", "Start Station", "End Station"], [
      ["S1", "4+47", "16+80"],
      ["S2", "16+80", "16+82"], // exactly continuous in survey notation
    ]);
    expect(runChecks([{ tabTitle: "PE1", data: mixed, keyColumn: 0 }])).toEqual([]);
  });

  it("flags duplicate keys in one tab (bore + plow double entry)", () => {
    const dupes = snap(["Shot", "Start Station", "End Station", "Type"], [
      ["S9", "0", "300", "bore"],
      ["S9", "0", "300", "plow"],
    ]);
    const findings = runChecks([{ tabTitle: "PE4", data: dupes, keyColumn: 0 }]);
    expect(findings.some((f) => f.kind === "dupe-key" && f.message.includes("2×"))).toBe(true);
  });

  it("flags the same shot in two tabs (PE6 vs PE7)", () => {
    const pe6 = snap(["Shot", "Start Station", "End Station"], [["S12", "0", "400"]]);
    const pe7 = snap(["Shot", "Start Station", "End Station"], [
      ["S11", "0", "100"],
      ["S12", "100", "400"],
    ]);
    const findings = runChecks([
      { tabTitle: "PE6", data: pe6, keyColumn: 0 },
      { tabTitle: "PE7", data: pe7, keyColumn: 0 },
    ]);
    const cross = findings.find((f) => f.kind === "cross-tab");
    expect(cross).toBeDefined();
    expect(cross!.message).toContain("PE6 and PE7");
  });
});
