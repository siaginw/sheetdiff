import { describe, expect, it } from "vitest";
import type { SnapshotData } from "./diff/engine";
import { traceKey, type TraceSnap } from "./trace";

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
        {
          at: 2000,
          rows: [
            ["S1", "0", "100", "plow"],
            ["S9", "100", "150", "bore"],
          ],
        },
        { at: 3000, rows: [["S1", "0", "100", "plow"]] }, // S9 deleted
      ]),
      "s9",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ at: 3000, kind: "removed" });
    expect(events[1]).toMatchObject({ at: 2000, kind: "added" });
  });

  it("stays quiet across snapshots that didn't touch the shot", () => {
    const events = traceKey(
      chain([
        {
          at: 1000,
          rows: [
            ["S1", "0", "100", "plow"],
            ["S2", "100", "200", "bore"],
          ],
        },
        {
          at: 2000,
          rows: [
            ["S1", "0", "100", "plow"],
            ["S2", "100", "999", "bore"],
          ],
        },
        {
          at: 3000,
          rows: [
            ["S1", "0", "500", "plow"],
            ["S2", "100", "999", "bore"],
          ],
        },
      ]),
      "s2",
    );
    expect(events).toHaveLength(1); // only the 2000 event; S1's change is invisible
    expect(events[0].at).toBe(2000);
  });

  it("returns nothing for a shot that never existed", () => {
    expect(traceKey(chain([{ at: 1000, rows: [["S1", "0", "100", "plow"]] }]), "zz")).toEqual([]);
  });
});

describe("traceKey without ID columns (station + text matching)", () => {
  const TH = ["Activity", "Start STA", "End STA", "Crew #"];
  const tchain = (items: { at: number; rows: string[][] }[]): TraceSnap[] =>
    items.map((i) => ({ createdAt: i.at, data: snap(TH, i.rows) }));

  it("traces by station number: the row covering that station", () => {
    const events = traceKey(
      tchain([
        {
          at: 1000,
          rows: [
            ["Plow", "0", "500", "CREW A"],
            ["Bore", "500", "900", "CREW B"],
          ],
        },
        {
          at: 2000,
          rows: [
            ["Plow", "0", "500", "CREW A"],
            ["Bore", "500", "900", "CREW C"],
          ],
        },
      ]),
      "700",
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("changed");
    expect(events[0].changes).toEqual([{ header: "Crew #", from: "CREW B", to: "CREW C" }]);
  });

  it("station mode uses the station columns — a row-index or footage column can't hijack the span", () => {
    const events = traceKey(
      [
        {
          createdAt: 1000,
          data: snap(
            ["#", "Activity", "Start STA", "End STA", "Footage"],
            [
              ["1", "Plow", "600", "900", "300"],
              ["2", "Bore", "0", "500", "500"],
            ],
          ),
        },
        {
          createdAt: 2000,
          data: snap(
            ["#", "Activity", "Start STA", "End STA", "Footage"],
            [
              ["1", "Plow", "600", "900", "300"],
              ["2", "Bore", "0", "500", "500"],
            ],
          ),
        },
      ],
      "450", // inside the Bore 0–500 span; row-1's "1" index would have matched first under old logic
    );
    // the Bore row exists in both snapshots unchanged → no events, but the
    // matcher must have FOUND it (previously it found the Plow row instead,
    // which also produced no events — assert via a visible mutation)
    const mutated = traceKey(
      [
        {
          createdAt: 1000,
          data: snap(
            ["#", "Activity", "Start STA", "End STA", "Footage"],
            [
              ["1", "Plow", "600", "900", "300"],
              ["2", "Bore", "0", "500", "500"],
            ],
          ),
        },
        {
          createdAt: 2000,
          data: snap(
            ["#", "Activity", "Start STA", "End STA", "Footage"],
            [
              ["1", "Plow", "600", "900", "999"], // plow's footage changed — must NOT appear in a 450-trace
              ["2", "Bore", "0", "500", "500"],
            ],
          ),
        },
      ],
      "450",
    );
    expect(mutated).toHaveLength(0); // the changed row (Plow @600–900) is not the one covering 450
  });

  it("traces by free text in any cell", () => {
    const events = traceKey(
      tchain([
        { at: 1000, rows: [["Plow", "0", "500", "CREW A"]] },
        {
          at: 2000,
          rows: [
            ["Plow", "0", "500", "CREW A"],
            ["Bore", "500", "900", "HAIDER 1"],
          ],
        },
        { at: 3000, rows: [["Plow", "0", "500", "CREW A"]] },
      ]),
      "HAIDER",
    );
    expect(events.map((e) => e.kind)).toEqual(["removed", "added"]);
  });
});
