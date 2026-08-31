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
  it("does not equate integers above double precision — long digit strings are identities", () => {
    // 17-digit ticket/reference numbers: Number() quantizes past 2^53, so the
    // last digit would silently compare equal. They must compare as text.
    expect(sameValue("123456789012345678", "123456789012345679")).toBe(false);
    expect(sameValue("123456789012345678", "123456789012345678")).toBe(true);
    // leading zeros stay insignificant only within exact-integer range
    expect(sameValue("007", "7")).toBe(true);
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
  it("never promotes a column with zero identifier evidence, however unique", () => {
    // padded label-only tab: every Notes value unique -> the old score-0
    // promotion keyed the diff on the label text, flipping a label edit into
    // remove+add (the flood the blank-key machinery exists to prevent)
    const s = snap(["Activity", "Start STA", "End STA", "Notes"], [
      ["Plow", "0", "500", "ZONE 2"],
      ["Plow", "0", "500", "ZONE 3"],
      ["Plow", "0", "500", "ZONE 4"],
    ]);
    expect(detectKeyColumn(s)).toBeNull();
    // consequence: a label edit is a CHANGE, not remove+add
    const b = snap(["Activity", "Start STA", "End STA", "Notes"], [
      ["Plow", "0", "500", "ZONE 2"],
      ["Plow", "0", "500", "ZONE 3 DONE"],
      ["Plow", "0", "500", "ZONE 4"],
    ]);
    const r = diffSnapshots(s, b);
    expect(r.summary.changedRows).toBe(1);
    expect(r.summary.addedRows + r.summary.removedRows).toBe(0);
  });
  it("detects identifier headers anywhere in the sheet, not just the first 12 columns", () => {
    const wide = Array.from({ length: 14 }, (_, i) => `Filler ${i + 1}`);
    wide[12] = "Ticket #";
    const rows = [
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "T-001", "x"],
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "T-002", "y"],
    ];
    expect(detectKeyColumn(snap(wide, rows))).toBe(12);
  });
  it("counts 'Shot #' and 'Emp #' as identifier headers", () => {
    const s = snap(["Shot #", "Activity"], [
      ["s1", "Plow"],
      ["s2", "Bore"],
    ]);
    expect(detectKeyColumn(s)).toBe(0);
  });
});

describe("composite keys (Activity + stations — trackers without ID columns)", () => {
  // real tracker schema: no ID column; identity = Activity + Start STA + End STA
  const trackerSnap = (rows: string[][]) => snap(["Activity", "Start STA", "End STA", "Crew #"], rows);
  const before = trackerSnap([
    ["Plow", "0", "500", "BIG M P1"],
    ["Bore", "500", "14800", "HAIDER 1"],
    ["Cobble Adder", "846", "922", "HAIDER 1"],
  ]);
  const after = trackerSnap([
    ["Plow", "0", "500", "BIG M P1"],
    ["Bore", "500", "14800", "HAIDER 2"], // crew changed on the same shot
    ["Cobble Adder", "846", "922", "HAIDER 1"],
  ]);

  it("matches rows by the composite and reports a clean cell change", () => {
    const r = diffSnapshots(before, after);
    expect(r.summary.changedRows).toBe(1);
    expect(r.summary.addedRows).toBe(0);
    expect(r.summary.removedRows).toBe(0);
    const row = r.rows.find((x) => x.status === "changed")!;
    expect(row.cells[0]).toMatchObject({ header: "Crew #", from: "HAIDER 1", to: "HAIDER 2" });
    expect(row.key).toContain("bore");
    expect(r.summary.keyColumnHeader).toContain("Activity");
  });

  it("a station edit changes identity → remove + add (as with single keys)", () => {
    const edited = trackerSnap([
      ["Plow", "0", "500", "BIG M P1"],
      ["Bore", "500", "14800", "HAIDER 1"],
      ["Bore", "500", "15743", "HAIDER 1"], // end station corrected: NEW identity
      ["Cobble Adder", "846", "922", "HAIDER 1"],
    ]);
    const r = diffSnapshots(before, edited);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(0); // old 500-14800 bore still exists
  });

  it("blank parts keep their position — skeleton rows never conflate", () => {
    // only non-unique columns outside the composite, so composite identity engages
    const filler = ["Plow", "900", "1000"];
    const a = snap(["Activity", "Start STA", "End STA"], [["Plow", "", "15743"], filler]);
    const b = snap(["Activity", "Start STA", "End STA"], [["Plow", "15743", ""], filler]);
    const r = diffSnapshots(a, b);
    // NOT one "changed" row: which part was blank differs, so identities differ
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1);
  });

  it("survives full re-sorts via composite matching", () => {
    const shuffled = trackerSnap([
      ["Cobble Adder", "846", "922", "HAIDER 1"],
      ["Bore", "500", "14800", "HAIDER 1"],
      ["Plow", "0", "500", "BIG M P1"],
    ]);
    const r = diffSnapshots(before, shuffled);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.movedRows).toBe(2); // Bore keeps index 1 in both orders
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
    expect(typeof changed.rowKey).toBe("string");
    expect(changed.rowKey.length).toBeGreaterThan(0);
  });

  it("uses the key column value as rowKey when present", () => {
    const next = structuredClone(base);
    next.rows[1][2] = "125";
    const r = diffSnapshots(base, next);
    expect(r.rows.find((x) => x.status === "changed")!.rowKey).toBe("2");
  });

  it("reports a stray blank row as added/removed, never as a change from blank", () => {
    const a = snap(["Name", "Qty"], [
      ["Nails", "40"],
      ["", ""], // stray blank row in A
      ["Screws", "10"],
    ]);
    const b = snap(["Name", "Qty"], [
      ["Nails", "40"],
      ["Screws", "10"],
      ["Bolts", "5"], // genuinely new row, no key column
    ]);
    const r = diffSnapshots(a, b);
    expect(r.summary.changedRows).toBe(0);
    expect(r.summary.addedRows).toBe(1);
    expect(r.summary.removedRows).toBe(1);
    expect(r.rows.find((x) => x.status === "added")!.values[0]).toBe("Bolts");
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
