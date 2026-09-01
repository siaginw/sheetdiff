import { describe, expect, it } from "vitest";
import { dedupeTabData } from "./dedupe";
import type { SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });
const HEAD = ["Activity", "Start STA", "End STA", "Crew #", "Date Complete"];

describe("dedupeTabData — work identity, not cell text", () => {
  it("matches a REFORMATTED compilation copy: survey notation, commas, retyped crew", () => {
    // the real tracker's Line List re-lists PE rows with "2+14" instead of
    // "214", thousands separators, and retyped crews — cell-text keys never
    // matched and the copy double-counted every number (+98% on placed-since)
    const pe = snap(HEAD, [
      ["Bore", "16400", "16500", "CREW A", "8/20/2026"],
      ["Plow", "0", "214", "Big M", "8/21/2026"],
      ["Plow", "15,743", "16,000", "CREW B", "8/22/2026"],
    ]);
    const lineList = snap(HEAD, [
      ["bore", "164+00", "165+00", "crew a", "8/20/26"],
      ["PLOW", "0+00", "2+14", "BIG M DRILL", "8/21/2026"],
      ["Plow", "15743", "16000", "Crew B", "8/22/2026"],
    ]);
    const out = dedupeTabData([
      { title: "PE-1", data: pe },
      { title: "Line List", data: lineList },
    ]);
    expect(out.pureCopies).toEqual(new Set(["Line List"]));
    expect(out.duplicatesDropped).toBe(3);
    // the working tab keeps everything
    expect(out.freshByTab.get("PE-1")).toEqual(pe.rows);
  });

  it("a copy with ONE unique row is NOT a pure copy — and its baseline is ownership-filtered (no -25,000 ft)", () => {
    const peLatest = snap(HEAD, [["Bore", "0", "500", "A", "8/1/2026"]]);
    const llLatest = snap(HEAD, [
      ["Bore", "0", "500", "A", "8/1/2026"], // the copied row
      ["Plow", "500", "600", "B", "8/5/2026"], // the compile straggler
    ]);
    const out = dedupeTabData([
      { title: "PE-1", data: peLatest },
      { title: "Line List", data: llLatest },
    ]);
    expect(out.pureCopies.size).toBe(0);
    expect(out.freshByTab.get("Line List")).toEqual([["", "", "", "", ""], ["Plow", "500", "600", "B", "8/5/2026"]]);

    // the copy's BASELINE re-listed the PE rows too: raw decode would put
    // 500+100 on the copy's side of the ledger and swing placed-since
    // negative right after collection. The owned slice keeps only its own.
    const llBaseline = snap(HEAD, [
      ["Bore", "0", "500", "A", "8/1/2026"],
      ["Plow", "500", "600", "B", "8/5/2026"],
    ]);
    const owned = out.ownedRows(new Map([["Line List", llBaseline]]));
    expect(owned.get("Line List")).toEqual([["", "", "", "", ""], ["Plow", "500", "600", "B", "8/5/2026"]]);
    // and the working tab's baseline keeps its own row even though the copy
    // re-listed it
    const peBaseline = snap(HEAD, [["Bore", "0", "500", "A", "8/1/2026"]]);
    const ownedPe = out.ownedRows(new Map([["PE-1", peBaseline], ["Line List", llBaseline]]));
    expect(ownedPe.get("PE-1")).toEqual([["Bore", "0", "500", "A", "8/1/2026"]]);
  });

  it("work that MOVED from the copy's baseline to the working tab nets out exactly once", () => {
    // the net-zero trap: Line List had the row at baseline, PE-1 has it at
    // latest. Ownership (decided on latest) assigns it to PE-1 for BOTH
    // slices, so PE-1 shows +ft and the copy shows nothing — never +ft and
    // -ft summing to a lie
    const peLatest = snap(HEAD, [["Bore", "0", "100", "A", "8/2/2026"]]);
    const peBaseline = snap(HEAD, []); // empty before
    const llLatest = snap(HEAD, []); // the compile dropped it
    const llBaseline = snap(HEAD, [["Bore", "0", "100", "A", "8/2/2026"]]);
    const out = dedupeTabData([
      { title: "PE-1", data: peLatest },
      { title: "Line List", data: llLatest },
    ]);
    const ownedPe = out.ownedRows(new Map([["PE-1", peBaseline]]));
    const ownedLl = out.ownedRows(new Map([["Line List", llBaseline]]));
    expect(ownedPe.get("PE-1")).toEqual([]); // baseline empty: +100 since
    // the row at the copy's baseline is NOT owned by the copy at latest —
    // it must vanish from the copy's baseline too, or the copy reports -100
    expect(ownedLl.get("Line List")).toEqual([["", "", "", "", ""]]);
  });

  it("rows REMOVED since latest stay with the tab that carried them (removals still net out)", () => {
    const latest = snap(HEAD, [["Bore", "0", "100", "A", "8/2/2026"]]);
    const baseline = snap(HEAD, [
      ["Bore", "0", "100", "A", "8/2/2026"],
      ["Plow", "100", "300", "A", "8/1/2026"], // removed since — key unseen at latest
    ]);
    const out = dedupeTabData([{ title: "PE-1", data: latest }]);
    const owned = out.ownedRows(new Map([["PE-1", baseline]]));
    expect(owned.get("PE-1")).toEqual(baseline.rows); // slice-local first-wins keeps both
  });

  it("duplicate rows WITHIN one tab are counted once and blanked in place", () => {
    const out = dedupeTabData([
      {
        title: "PE-1",
        data: snap(HEAD, [
          ["Bore", "0", "500", "A", "8/1/2026"],
          ["Bore", "0", "500", "A", "8/1/2026"], // same work identity twice
          ["Bore", "500", "900", "A", "8/2/2026"],
        ]),
      },
    ]);
    expect(out.duplicatesDropped).toBe(1);
    expect(out.freshByTab.get("PE-1")).toEqual([
      ["Bore", "0", "500", "A", "8/1/2026"],
      ["", "", "", "", ""],
      ["Bore", "500", "900", "A", "8/2/2026"],
    ]);
    expect(out.pureCopies.size).toBe(0);
  });

  it("NUL bytes in cells cannot forge a key collision between different rows", () => {
    // tab A's row "a\0b","z" and tab B's row "a","b\0z" used to NUL-join to
    // the same content key — B's distinct row silently vanished
    const a = snap(["X", "Y"], [["a\0b", "z"]]);
    const b = snap(["X", "Y"], [["a", "b\0z"]]);
    const out = dedupeTabData([
      { title: "A", data: a },
      { title: "B", data: b },
    ]);
    expect(out.duplicatesDropped).toBe(0);
    expect(out.pureCopies.size).toBe(0);
  });

  it("station-less tabs fall back to content keys — two identical log tabs, second is a copy", () => {
    const log = snap(["Date", "Note"], [["8/1/2026", "pump down"]]);
    const out = dedupeTabData([
      { title: "Log", data: log },
      { title: "Log Copy", data: snap(["Date", "Note"], [["8/1/2026", "pump down"]]) },
    ]);
    expect(out.pureCopies).toEqual(new Set(["Log Copy"]));
  });

  it("whitespace variants of the same stations are one identity; different stations are not", () => {
    const out = dedupeTabData([
      { title: "A", data: snap(HEAD, [["Bore", " 0 ", "500", "A", "8/1/2026"]]) },
      { title: "B", data: snap(HEAD, [["Bore", "0", "500.0", "A", "8/1/2026"]]) }, // same shot
      { title: "C", data: snap(HEAD, [["Bore", "0", "501", "A", "8/1/2026"]]) }, // different
    ]);
    expect(out.duplicatesDropped).toBe(1);
    // B's only row was owned by A — B is a pure copy
    expect(out.pureCopies).toEqual(new Set(["B"]));
    // C keeps its own row
    expect(out.freshByTab.get("C")).toEqual([["Bore", "0", "501", "A", "8/1/2026"]]);
  });
});
