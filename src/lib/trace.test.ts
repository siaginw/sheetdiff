import { describe, it, expect } from "vitest";
import { traceKey, type TraceSnap } from "./trace";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });
const H = ["Shot", "Start Station", "End Station", "Type"];

function chain(items: { at: number; rows: string[][] }[]): TraceSnap[] {
  return items.map((i) => ({ createdAt: i.at, data: snap(H, i.rows) }));
}

describe("traceKey", () => {
  it("reports each value change of a shot across snapshots, newest first", () => {
    const events = traceKey(
      chain([
        { at: 1000, rows: [["S5", "16000", "164+80", "bore"]] },
        { at: 2000, rows: [["S5", "16000", "164+82", "bore"]] }, // end station fixed
        { at: 3000, rows: [["S5", "16000", "164+82", "plow"]] }, // type flipped
      ]),
      0,
      "s5",
    );
    expect(events).toHaveLength(2);
    expect(events[0].at).toBe(3000); // newest first
    expect(events[0].changes).toEqual([{ header: "Type", from: "bore", to: "plow" }]);
    expect(events[1].at).toBe(2000);
    expect(events[1].changes[0]).toMatchObject({ header: "End Station", from: "164+80", to: "164+82" });
  });

  it("reports first appearance and removal", () => {
    const events = traceKey(
      chain([
        { at: 1000, rows: [["S1", "0", "100", "plow"]] },
        { at: 2000, rows: [["S1", "0", "100", "plow"], ["S9", "100", "150", "bore"]] },
        { at: 3000, rows: [["S1", "0", "100", "plow"]] }, // S9 deleted
      ]),
      0,
      "s9",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ at: 3000, kind: "removed" });
    expect(events[1]).toMatchObject({ at: 2000, kind: "added" });
  });

  it("stays quiet across snapshots that didn't touch the shot", () => {
    const events = traceKey(
      chain([
        { at: 1000, rows: [["S1", "0", "100", "plow"], ["S2", "100", "200", "bore"]] },
        { at: 2000, rows: [["S1", "0", "100", "plow"], ["S2", "100", "999", "bore"]] },
        { at: 3000, rows: [["S1", "0", "500", "plow"], ["S2", "100", "999", "bore"]] },
      ]),
      0,
      "s2",
    );
    expect(events).toHaveLength(1); // only the 2000 event; S1's change is invisible
    expect(events[0].at).toBe(2000);
  });

  it("returns nothing for a shot that never existed", () => {
    expect(traceKey(chain([{ at: 1000, rows: [["S1", "0", "100", "plow"]] }]), 0, "zz")).toEqual([]);
  });
});
