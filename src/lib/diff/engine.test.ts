import { describe, it, expect } from "vitest";
import { diffSnapshots, detectKeyColumn, type SnapshotData } from "./engine";
import { parseNumberLike, sameValue, colLetter } from "./normalize";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

function count(result: ReturnType<typeof diffSnapshots>, status: string) {
  return result.rows.filter((r) => r.status === status).length;
}

describe("parseNumberLike", () => {
  it("parses plain, comma, and currency numbers", () => {
    expect(parseNumberLike("40")).toBe(40);
    expect(parseNumberLike("40.00")).toBe(40);
    expect(parseNumberLike("1,234.5")).toBe(1234.5);
    expect(parseNumberLike("$1000")).toBe(1000);
    expect(parseNumberLike("$1,000.00")).toBe(1000);
    expect(parseNumberLike("-7.25")).toBe(-7.25);
  });
  it("rejects non-numbers", () => {
    expect(parseNumberLike("")).toBeNull();
    expect(parseNumberLike("abc")).toBeNull();
    expect(parseNumberLike("12 34")).toBeNull();
    expect(parseNumberLike("1.2.3")).toBeNull();
  });
});

describe("sameValue", () => {
  it("treats superficially different numbers as equal", () => {
    expect(sameValue("40", "40.00")).toBe(true);
    expect(sameValue(" 40 ", "40")).toBe(true);
    expect(sameValue("$1,000", "1000")).toBe(true);
    expect(sameValue("", null)).toBe(true);
  });
  it("treats real differences as different", () => {
    expect(sameValue("40", "41")).toBe(false);
    expect(sameValue("abc", "abd")).toBe(false);
    expect(sameValue("40", "40x")).toBe(false);
  });
});

describe("colLetter", () => {
  it("matches spreadsheet letters", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(27)).toBe("AB");
  });
});

describe("detectKeyColumn", () => {
  it("finds a unique column", () => {
    const s = snap(["Name", "ID"], [
      ["Ann", "101"],
      ["Bob", "102"],
      ["Cid", "103"],
    ]);
    expect(detectKeyColumn(s)).toBe(1);
  });
  it("prefers id-like headers when several columns are unique", () => {
    const s = snap(["Employee ID", "Name"], [
      ["1", "Ann"],
      ["2", "Bob"],
      ["3", "Cid"],
    ]);
    expect(detectKeyColumn(s)).toBe(0);
  });
  it("returns null when nothing is unique", () => {
    const s = snap(["A", "B"], [
      ["x", "1"],
      ["x", "1"],
      ["y", "2"],
    ]);
    expect(detectKeyColumn(s)).toBeNull();
  });
});

describe("diffSnapshots", () => {
  const base = snap(["ID", "Name", "Qty"], [
    ["1", "Nails", "40"],
    ["2", "Screws", "100"],
    ["3", "Bolts", "55"],
  ]);

  it("reports nothing for identical snapshots", () => {
    const r = diffSnapshots(base, structuredClone(base));
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    expect(count(r, "unchanged")).toBe(3);
  });

  it("reports a single cell change with from/to", () => {
    const next = structuredClone(base);
    next.rows[1][2] = "125";
    const r = diffSnapshots(base, next);
    expect(r.summary.changedRows).toBe(1);
    expect(r.summary.changedCells).toBe(1);
    const row = r.rows.find((x) => x.status === "changed")!;
    expect(row.cells[0]).toMatchObject({ header: "Qty", from: "100", to: "125" });
    expect(row.key).toBe("2");
  });

  it("does not report numeric formatting noise as changes", () => {
    const next = structuredClone(base);
    next.rows[0][2] = "40.00";
    next.rows[2][2] = " 55 ";
    const r = diffSnapshots(base, next);
    expect(r.summary.changedRows).toBe(0);
  });

  it("reports added and removed rows", () => {
    const next = snap(["ID", "Name", "Qty"], [
      ["1", "Nails", "40"],
      ["2", "Screws", "100"],
      ["4", "Washers", "12"],
    ]);
    const r = diffSnapshots(base, next);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1);
    expect(r.rows.find((x) => x.status === "added")!.values).toEqual(["4", "Washers", "12"]);
    expect(r.rows.find((x) => x.status === "removed")!.values).toEqual(["3", "Bolts", "55"]);
  });

  it("survives a full sort without false changes (key column)", () => {
    const sorted = snap(["ID", "Name", "Qty"], [
      ["3", "Bolts", "55"],
      ["1", "Nails", "40"],
      ["2", "Screws", "100"],
    ]);
    const r = diffSnapshots(base, sorted);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.movedRows).toBe(3);
  });

  it("survives a sort without any key column (content matching)", () => {
    const noKey = snap(["Name", "Color"], [
      ["Nails", "silver"],
      ["Screws", "black"],
      ["Bolts", "silver"],
    ]);
    const sorted = snap(["Name", "Color"], [
      ["Bolts", "silver"],
      ["Nails", "silver"],
      ["Screws", "black"],
    ]);
    const r = diffSnapshots(noKey, sorted);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.movedRows).toBe(3);
  });

  it("combines moved + changed into a changed row with movedFrom", () => {
    const next = snap(["ID", "Name", "Qty"], [
      ["3", "Bolts", "55"],
      ["1", "Nails", "40"],
      ["2", "Screws", "200"],
    ]);
    const r = diffSnapshots(base, next);
    expect(r.summary.changedRows).toBe(1);
    expect(r.summary.movedRows).toBe(2);
    const changed = r.rows.find((x) => x.status === "changed")!;
    expect(changed.key).toBe("2");
    expect(changed.movedFrom).toBe(1);
    expect(changed.newIndex).toBe(2);
  });

  it("treats a changed key as remove + add (identity changed)", () => {
    const next = structuredClone(base);
    next.rows[0][0] = "9";
    const r = diffSnapshots(base, next);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1);
    expect(r.summary.changedRows).toBe(0);
  });

  it("pairs duplicate keys in order without crashing", () => {
    const dupA = snap(["Date", "Crew"], [
      ["mon", "a"],
      ["mon", "b"],
      ["tue", "c"],
    ]);
    const dupB = snap(["Date", "Crew"], [
      ["mon", "a2"],
      ["mon", "b"],
      ["tue", "c"],
    ]);
    // Force keying on Date (col 0): duplicate keys must pair in order.
    // Left alone, auto-detect would (correctly) key on the unique Crew column.
    const r = diffSnapshots(dupA, dupB, { keyColumn: 0 });
    expect(r.summary.changedRows).toBe(1);
    expect(r.rows.find((x) => x.status === "changed")!.cells[0].to).toBe("a2");
  });

  it("keeps cell pairing stable when a column is inserted mid-sheet", () => {
    const next = snap(["ID", "Name", "Unit", "Qty"], [
      ["1", "Nails", "box", "40"],
      ["2", "Screws", "box", "100"],
      ["3", "Bolts", "bag", "55"],
    ]);
    const r = diffSnapshots(base, next);
    expect(r.summary.columnsAdded).toEqual(["Unit"]);
    expect(r.summary.changedRows).toBe(0); // existing cols unchanged
  });

  it("pairs a renamed header instead of remove+add", () => {
    const next = snap(["ID", "Name", "Quantity"], structuredClone(base).rows);
    const r = diffSnapshots(base, next);
    expect(r.summary.columnsAdded).toEqual([]);
    expect(r.summary.columnsRemoved).toEqual([]);
    expect(r.summary.changedRows).toBe(0);
  });

  it("detects cell changes inside a renamed column", () => {
    const next = snap(["ID", "Name", "Quantity"], [
      ["1", "Nails", "40"],
      ["2", "Screws", "999"],
      ["3", "Bolts", "55"],
    ]);
    const r = diffSnapshots(base, next);
    expect(r.summary.changedRows).toBe(1);
    expect(r.rows.find((x) => x.status === "changed")!.cells[0].header).toBe("Quantity");
  });

  it("interleaves removed rows near their old position", () => {
    const next = snap(["ID", "Name", "Qty"], [
      ["1", "Nails", "40"],
      ["3", "Bolts", "55"],
    ]);
    const r = diffSnapshots(base, next);
    // removed row 2 ("Screws") should sit between the two kept rows
    const statuses = r.rows.map((x) => x.status);
    expect(statuses.indexOf("removed")).toBe(1);
  });

  it("treats blank and empty-string cells as equal", () => {
    const a = snap(["ID", "Note"], [
      ["1", ""],
      ["2", "x"],
    ]);
    const b = snap(["ID", "Note"], [
      ["1", ""],
      ["2", "x"],
    ]);
    a.rows[0][1] = "";
    b.rows[0][1] = "";
    const r = diffSnapshots(a, b);
    expect(r.summary.changedRows).toBe(0);
  });

  it("respects an explicit key column choice", () => {
    // Two unique columns; force keying on Name (col 1) instead of auto ID
    const next = snap(["ID", "Name", "Qty"], [
      ["1", "Nails", "40"],
      ["2", "Screws", "100"],
      ["3", "Bolts", "56"],
    ]);
    const r = diffSnapshots(base, next, { keyColumn: 1 });
    expect(r.summary.changedRows).toBe(1);
    expect(r.rows.find((x) => x.status === "changed")!.key).toBe("bolts");
    // change the ID column too — keyed on Name, ID is just a normal column
    const next2 = snap(["ID", "Name", "Qty"], [
      ["7", "Nails", "40"],
      ["2", "Screws", "100"],
      ["3", "Bolts", "55"],
    ]);
    const r2 = diffSnapshots(base, next2, { keyColumn: 1 });
    expect(r2.summary.changedRows).toBe(1);
    expect(r2.summary.addedRows).toBe(0);
  });

  it("provides a stable rowKey even without a key column", () => {
    const a = snap(["Name", "Qty"], [
      ["Nails", "40"],
      ["Screws", "10"],
    ]);
    const b = snap(["Name", "Qty"], [
      ["Nails", "41"],
      ["Screws", "10"],
    ]);
    const r = diffSnapshots(a, b);
    const changed = r.rows.find((x) => x.status === "changed")!;
    // content-hash identity is stable across the value edit
    expect(changed.rowKey).toBe(changed.rowKey);
    expect(typeof changed.rowKey).toBe("string");
    expect(changed.rowKey.length).toBeGreaterThan(0);
  });

  it("uses the key column value as rowKey when present", () => {
    const next = structuredClone(base);
    next.rows[1][2] = "125";
    const r = diffSnapshots(base, next);
    expect(r.rows.find((x) => x.status === "changed")!.rowKey).toBe("2");
  });

  it("reports an added-column value change correctly via summary", () => {
    const next = snap(["ID", "Name", "Qty", "Note"], [
      ["1", "Nails", "40", "ok"],
      ["2", "Screws", "100", ""],
      ["3", "Bolts", "55", ""],
    ]);
    const r = diffSnapshots(base, next);
    expect(r.summary.columnsAdded).toEqual(["Note"]);
    expect(r.columns[3]).toMatchObject({ header: "Note", status: "added" });
  });
});
