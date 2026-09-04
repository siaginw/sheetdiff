import { describe, expect, it } from "vitest";
import { diffSnapshots, type SnapshotData } from "./engine";
import { columnWidths } from "./widths";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

describe("columnWidths (lines-mode layout math)", () => {
  it("headers set the minimum, cells grow it, everything caps at 22ch", () => {
    const a = snap(["Shot", "Notes"], [["s1", "short"]]);
    const b = snap(
      ["Shot", "Notes"],
      [
        ["s1", "short"],
        ["s2", "a-much-longer-note-value-here"],
      ],
    );
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    const w = columnWidths(r, r.rows);
    expect(w[0]).toBe(Math.max(3, "Shot".length)); // header minimum ("s2" doesn't beat it)
    expect(w[1]).toBe(22); // capped
  });

  it("changed rows are measured by their OLD values too (the − line must fit)", () => {
    const a = snap(["ID", "Note"], [["1", "old-value-that-is-long"]]);
    const b = snap(["ID", "Note"], [["1", "x"]]);
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    const w = columnWidths(r, r.rows);
    expect(w[1]).toBe("old-value-that-is-long".length); // measured from A, not B's "x"
  });

  it("visible-only: hidden rows never stretch columns", () => {
    const a = snap(["ID", "Note"], [["1", ""]]);
    const b = snap(
      ["ID", "Note"],
      [
        ["1", ""],
        ["2", "wide-hidden-value"],
      ],
    );
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    const added = r.rows.find((x) => x.status === "added")!;
    const unchanged = r.rows.find((x) => x.status === "unchanged")!;
    // with the added row visible, the column widens; hidden, it does not
    expect(columnWidths(r, [added])[1]).toBe("wide-hidden-value".length);
    expect(columnWidths(r, [unchanged])[1]).toBe(Math.max(3, "Note".length));
  });
});
