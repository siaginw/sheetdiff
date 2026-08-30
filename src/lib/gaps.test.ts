import { describe, it, expect } from "vitest";
import { computeGapReport } from "./gaps";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });
const H = ["Activity", "Start STA", "End STA"];

describe("computeGapReport", () => {
  it("ignores handholes and adders — only bore/plow/gap form the chain", () => {
    const r = computeGapReport(
      snap(H, [
        ["Plow", "0", "500"],
        ["48 Handhole", "500", "500"],  // sits on a station, skipped
        ["Bore", "500", "900"],
        ["Cobble Adder", "500", "900"], // billing overlay, skipped
      ]),
    );
    expect(r.placedFt).toBe(900);
    expect(r.unaccounted).toEqual([]);
    expect(r.overlaps).toEqual([]);
    expect(r.designedSpan).toBe(900);
  });

  it("separates known gaps (booked) from unaccounted gaps (chain holes)", () => {
    const r = computeGapReport(
      snap(H, [
        ["Plow", "0", "500"],
        ["GAP", "500", "620"],   // booked by the crew
        ["Bore", "620", "900"],
        ["Plow", "950", "1200"], // 900→950 was never booked — the actionable hole
      ]),
    );
    expect(r.placedFt).toBe(500 + 280 + 250);
    expect(r.knownGaps).toHaveLength(1);
    expect(r.knownGaps[0]).toMatchObject({ from: 500, to: 620, ft: 120 });
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]).toMatchObject({ from: 900, to: 950, ft: 50 });
    expect(r.designedSpan).toBe(1200);
  });

  it("sorts out-of-order rows before chaining (appended corrections)", () => {
    const r = computeGapReport(
      snap(H, [
        ["Plow", "0", "500"],
        ["Plow", "950", "1200"],
        ["Bore", "500", "950"], // appended later, out of order
      ]),
    );
    expect(r.unaccounted).toEqual([]);
    expect(r.placedFt).toBe(1200);
  });

  it("flags overlaps in the reconstructed chain", () => {
    const r = computeGapReport(
      snap(H, [
        ["Plow", "0", "500"],
        ["Bore", "400", "900"], // 100 ft double-counted
      ]),
    );
    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0]).toMatchObject({ from: 400, to: 500, ft: 100 });
    expect(r.placedFt).toBe(1000); // raw span sum; minus the 100 ft overlap = 900 designed
  });

  it("reconciles: placed + known + unaccounted − overlaps = designed span", () => {
    const r = computeGapReport(
      snap(H, [
        ["Plow", "0", "500"],
        ["GAP", "500", "620"],
        ["Bore", "620", "900"],
        ["Plow", "950", "1200"],
      ]),
    );
    const accounted =
      r.placedFt +
      r.knownGaps.reduce((n, g) => n + g.ft, 0) +
      r.unaccounted.reduce((n, g) => n + g.ft, 0) -
      r.overlaps.reduce((n, g) => n + g.ft, 0);
    expect(accounted).toBe(r.designedSpan);
  });

  it("returns an empty report without station columns", () => {
    const r = computeGapReport(snap(["Crew", "Task"], [["A", "B"]]));
    expect(r.chainStart).toBeNull();
    expect(r.placedFt).toBe(0);
  });
});
