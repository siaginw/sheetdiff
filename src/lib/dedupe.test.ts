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
    expect(out.freshByTab.get("Line List")).toEqual([
      ["", "", "", "", ""],
      ["Plow", "500", "600", "B", "8/5/2026"],
    ]);

    // the copy's BASELINE re-listed the PE rows too: raw decode would put
    // 500+100 on the copy's side of the ledger and swing placed-since
    // negative right after collection. The owned slice keeps only its own.
    const llBaseline = snap(HEAD, [
      ["Bore", "0", "500", "A", "8/1/2026"],
      ["Plow", "500", "600", "B", "8/5/2026"],
    ]);
    const owned = out.ownedRows(new Map([["Line List", llBaseline]]));
    expect(owned.get("Line List")).toEqual([
      ["", "", "", "", ""],
      ["Plow", "500", "600", "B", "8/5/2026"],
    ]);
    // and the working tab's baseline keeps its own row even though the copy
    // re-listed it
    const peBaseline = snap(HEAD, [["Bore", "0", "500", "A", "8/1/2026"]]);
    const ownedPe = out.ownedRows(
      new Map([
        ["PE-1", peBaseline],
        ["Line List", llBaseline],
      ]),
    );
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

describe("dedupeTabData — smart identifiers on ANY sheet", () => {
  const INV = ["SKU", "Item", "Qty", "Location"];

  it("an inventory sheet keyed by SKU detects a reformatted compilation copy", () => {
    // no stations anywhere — identity comes from the auto-detected key column
    const stock = snap(INV, [
      ["A-100", "Pump 2in", "4", "Yard 1"],
      ["B-220", "Valve 6in", "12", "Yard 2"],
      ["C-330", "Coupler", "40", "Trailer 3"],
    ]);
    const masterList = snap(
      ["Part", "Description", "On Hand", "Yard"],
      [
        ["a-100", 'Pump 2"', "4", "Yard 1"], // retyped description, same key
        ["B-220", "Valve 6in", "12", "Yard 2"],
        ["C-330", "Coupler", "40", "Trailer 3"],
      ],
    );
    const out = dedupeTabData([
      { title: "Stock", data: stock, keyColumn: null },
      { title: "Master List", data: masterList, keyColumn: null },
    ]);
    expect(out.pureCopies).toEqual(new Set(["Master List"]));
    expect(out.duplicatesDropped).toBe(3);
  });

  it("the same key twice in ONE tab is two rows, not a duplicate", () => {
    // two warehouse lines for one SKU — both kept (unlike station work
    // identity, where the same shot listed twice is one shot)
    const stock = snap(INV, [
      ["A-100", "Pump 2in", "4", "Yard 1"],
      ["A-100", "Pump 2in", "2", "Trailer 3"],
      ["B-220", "Valve 6in", "12", "Yard 2"],
    ]);
    const other = snap(INV, [["Z-999", "Widget", "1", "Yard 9"]]);
    const out = dedupeTabData([
      { title: "Stock", data: stock, keyColumn: null },
      { title: "Other", data: other, keyColumn: null },
    ]);
    expect(out.duplicatesDropped).toBe(0);
    expect(out.freshByTab.get("Stock")).toHaveLength(3);
    expect(out.pureCopies.size).toBe(0);
    // a later tab re-listing the rows still dedups — note the tier mismatch:
    // Stock's SKU values repeat, so Stock keyed by CONTENT while Copy (unique
    // keys) keyed by COLUMN; the verbatim rows still match through the dual
    // identity. (Known edge: a REFORMATTED copy of a repeat-keyed tab whose
    // values also changed matches on neither tier and is kept — merging on a
    // non-unique value would collide rows that merely share a date.)
    const copy = snap(INV, [
      ["A-100", "Pump 2in", "4", "Yard 1"],
      ["B-220", "Valve 6in", "12", "Yard 2"],
    ]);
    const out2 = dedupeTabData([
      { title: "Stock", data: stock, keyColumn: null },
      { title: "Copy", data: copy, keyColumn: null },
    ]);
    expect(out2.freshByTab.get("Copy")).toEqual([
      ["", "", "", ""],
      ["", "", "", ""],
    ]);
    expect(out2.pureCopies).toEqual(new Set(["Copy"]));
  });

  it("an invalid explicit key column degrades to the next tier instead of colliding rows", () => {
    // someone picked "Activity" as the key, but activities repeat — the
    // choice is ignored (validated like auto-detection: populated + unique)
    const H = ["Activity", "Start STA", "End STA"];
    const t1 = snap(H, [
      ["Plow", "0", "500"],
      ["Bore", "700", "900"],
      ["Bore", "900", "1000"], // "Bore" repeats — column 0 cannot identify
    ]);
    const t2 = snap(H, [
      ["Plow", "0", "1000"],
      ["Bore", "1000", "1100"],
    ]);
    const out = dedupeTabData([
      { title: "A", data: t1, keyColumn: 0 },
      { title: "B", data: t2, keyColumn: 0 },
    ]);
    // without the guard, "plow"/"bore" collide cross-tab and B becomes a copy
    expect(out.pureCopies.size).toBe(0);
    expect(out.duplicatesDropped).toBe(0);
  });

  it("identity tier is decided on LATEST data and applied to every slice", () => {
    // the cross-time trap: a 2-row tab where the override looks valid at
    // latest. The baseline (1 row, any column is "unique") must key the SAME
    // way, or the baseline row vanishes and placed-since inflates.
    const H = ["Activity", "Start STA", "End STA"];
    const latest = snap(H, [
      ["Plow", "0", "500"],
      ["Bore", "500", "900"], // activities distinct at latest: override valid
    ]);
    const baseline = snap(H, [["Plow", "0", "500"]]);
    const out = dedupeTabData([{ title: "A", data: latest, keyColumn: 0 }]);
    const owned = out.ownedRows(new Map([["A", baseline]]));
    // the baseline plow row keys k:plow at latest AND k:plaw at the slice —
    // same tier, same namespace, still owned by A
    expect((owned.get("A") ?? [])[0]).toEqual(["Plow", "0", "500"]);
  });
});

describe("audit-pass regression tests (identity stability + copy bounds)", () => {
  it("C1: the auto-detected key column is resolved on LATEST and applied to the baseline", () => {
    // latest: Date is unique -> tier 3 keys by Date. Baseline: two rows share
    // a date (ordinary) so detection there would flip to SKU — the SAME row
    // must still key by Date (latest's column), or the baseline escapes
    // ownership and placed-since goes wrong
    const H = ["SKU", "Date", "Qty"];
    const latest = snap(H, [
      ["A1", "2026-08-01", "3"],
      ["A2", "2026-08-02", "4"],
      ["A3", "2026-08-03", "5"],
    ]);
    const baseline = snap(H, [
      ["A1", "2026-08-01", "3"],
      ["A2", "2026-08-01", "4"], // same day as A1 — Date NOT unique here
      ["A3", "2026-08-03", "5"],
    ]);
    const out = dedupeTabData([{ title: "Work", data: latest, keyColumn: null }]);
    const owned = out.ownedRows(new Map([["Work", baseline]]));
    // all three baseline rows survive as the tab's own (no vanishing)
    expect((owned.get("Work") ?? []).filter((r) => r.some((v) => v !== ""))).toHaveLength(3);
  });

  it("H1: a real ID column outranks a unique Date column", async () => {
    const { detectKeyColumn } = await import("./diff/engine");
    const H = ["SKU", "Date", "Qty"];
    const data = snap(H, [
      ["A1", "2026-08-01", "3"],
      ["A2", "2026-08-02", "4"],
      ["A3", "2026-08-03", "5"],
    ]);
    expect(detectKeyColumn(data)).toBe(0); // SKU, not Date
    // a date-only sheet still keys by date (nothing better exists)
    const D = ["Date", "Task"];
    expect(
      detectKeyColumn(
        snap(D, [
          ["2026-08-01", "a"],
          ["2026-08-02", "b"],
        ]),
      ),
    ).toBe(0);
  });

  it("C2: two same-period daily-log tabs are NOT copies of each other", () => {
    // 21 unique dates each, completely different work — keying by date used
    // to make the second tab a pure copy and vanish it from every rollup
    const H = ["Date", "Task", "Qty"];
    const days = (n: number) => `2026-08-${String(n).padStart(2, "0")}`;
    const rows = (prefix: string) => Array.from({ length: 21 }, (_, i) => [days(i + 1), `${prefix} ${i + 1}`, "1"]);
    const out = dedupeTabData([
      { title: "Crew A log", data: snap(H, rows("inspect line")), keyColumn: null },
      { title: "Crew B log", data: snap(H, rows("repair valve")), keyColumn: null },
    ]);
    expect(out.pureCopies.size).toBe(0);
    expect(out.duplicatesDropped).toBe(0);
  });

  it("H3: a 95%-copy tab that owns real stragglers is NOT skipped (20 copies + 1 owned = 4.8%)", () => {
    const H = ["SKU", "Qty"];
    const work = snap(
      H,
      Array.from({ length: 20 }, (_, i) => [`S-${i}`, "1"]),
    );
    const mostlyCopy = snap(H, [
      ...Array.from({ length: 20 }, (_, i) => [`S-${i}`, "1"]),
      ["MINE-1", "7"], // the tab's OWN row
    ]);
    const out = dedupeTabData([
      { title: "Work", data: work, keyColumn: null },
      { title: "Mostly Copy", data: mostlyCopy, keyColumn: null },
    ]);
    expect(out.pureCopies.has("Mostly Copy")).toBe(false);
    // its owned row survives in the fresh output
    expect((out.freshByTab.get("Mostly Copy") ?? []).some((r) => r[0] === "MINE-1")).toBe(true);
  });

  it("H3 (the other side): a big copy with ~2% reformatted strays IS still a compilation tab", () => {
    // the real Line List shape: 1354 rows, 26 strays = 1.9% — must classify
    const H = ["SKU", "Qty"];
    const n = 200;
    const work = snap(
      H,
      Array.from({ length: n }, (_, i) => [`S-${i}`, "1"]),
    );
    const bigCopy = snap(H, [
      ...Array.from({ length: n }, (_, i) => [`S-${i}`, "1"]),
      ...Array.from({ length: 4 }, (_, i) => [`STRAY-${i}`, "9"]), // 4/204 = 2.0%
    ]);
    const out = dedupeTabData([
      { title: "Work", data: work, keyColumn: null },
      { title: "Big Copy", data: bigCopy, keyColumn: null },
    ]);
    expect(out.pureCopies.has("Big Copy")).toBe(true);
  });

  it("M1: k-namespace removals net out per tab — within-tab repeats kept, cross-tab repeats dropped", () => {
    const H = ["SKU", "Qty"];
    const override = 0;
    const latest = snap(H, [["Y", "9"]]);
    const baseline = snap(H, [
      ["X", "1"],
      ["X", "2"], // a second warehouse line for X, since removed
      ["Y", "9"],
    ]);
    const out = dedupeTabData([{ title: "Work", data: latest, keyColumn: override }]);
    const owned = out.ownedRows(new Map([["Work", baseline]]));
    const kept = (owned.get("Work") ?? []).filter((r) => r.some((v) => v !== ""));
    expect(kept).toHaveLength(3); // both X rows survive the slice walk

    // cross-tab: A and B both carried the removed row — only A (first) keeps it
    const aLatest = snap(H, [["Z", "1"]]);
    const bLatest = snap(H, [["W", "1"]]);
    const out2 = dedupeTabData([
      { title: "A", data: aLatest, keyColumn: override },
      { title: "B", data: bLatest, keyColumn: override },
    ]);
    const owned2 = out2.ownedRows(
      new Map([
        ["A", snap(H, [["GONE", "1"]])],
        ["B", snap(H, [["GONE", "1"]])],
      ]),
    );
    const aKept = (owned2.get("A") ?? []).filter((r) => r.some((v) => v !== "")).length;
    const bKept = (owned2.get("B") ?? []).filter((r) => r.some((v) => v !== "")).length;
    expect(aKept).toBe(1);
    expect(bKept).toBe(0);
  });
});

describe("v0.5.2 audit fixes", () => {
  it("H1: a layout drift since the baseline cannot key rows by the WRONG column", () => {
    // Work's LATEST added a leading Ref column, so the auto key resolved on
    // col 0 (Ref). Its BASELINE has Code at col 0 — without the header guard,
    // the baseline's Code values key as k:<ref> and can collide with another
    // tab's refs, blanking Work's OWN rows
    const master = snap(
      ["Code", "Note"],
      [
        ["T1", "a"],
        ["T2", "b"],
        ["T3", "c"],
      ],
    );
    const workLatest = snap(
      ["Ref", "Code2", "Qty"],
      [
        ["R1", "x", "1"],
        ["R2", "y", "2"],
      ],
    );
    const workBaseline = snap(
      ["Code", "Qty"],
      [
        ["T1", "1"], // same VALUES as Master's codes — must NOT be misread as k:T1
        ["T2", "2"],
        ["T3", "3"],
      ],
    );
    const out = dedupeTabData([
      { title: "Master", data: master, keyColumn: null },
      { title: "Work", data: workLatest, keyColumn: null },
    ]);
    const owned = out.ownedRows(new Map([["Work", workBaseline]]));
    const kept = (owned.get("Work") ?? []).filter((r) => r.some((v) => v !== ""));
    expect(kept).toHaveLength(3); // all of Work's own baseline rows survive
  });

  it("M1: a 'Day No' column does not become the identity (two same-week logs stay separate)", () => {
    const H = ["Day No", "Task"];
    const rows = (p: string) => Array.from({ length: 10 }, (_, i) => [String(i + 1), `${p} ${i + 1}`]);
    const out = dedupeTabData([
      { title: "Crew A", data: snap(H, rows("dig")), keyColumn: null },
      { title: "Crew B", data: snap(H, rows("haul")), keyColumn: null },
    ]);
    expect(out.pureCopies.size).toBe(0);
    expect(out.duplicatesDropped).toBe(0);
  });
});

describe("v0.6.2 audit fixes", () => {
  it("a NARROWER compilation tab listed FIRST no longer flips ownership (richness-first order)", () => {
    // the real Frost shape: Line List (fewer columns) precedes the PE tabs
    // in workbook order — with position order it owned everything and the
    // WORKING tabs were classified as its copies, flipping the billing basis
    const WIDE = ["Activity", "Start STA", "End STA", "Crew #", "Date Complete", "Note"];
    const NARROW = ["Activity", "Start STA", "End STA"];
    const rows = [
      ["Plow", "0", "500", "CREW A", "8/1/2026", "ok"],
      ["Bore", "500", "900", "CREW B", "8/2/2026", "ok"],
      ["Bore", "900", "1000", "CREW C", "8/3/2026", "ok"],
    ];
    const out = dedupeTabData([
      {
        title: "Line List",
        data: snap(
          NARROW,
          rows.map((r) => r.slice(0, 3)),
        ),
        keyColumn: null,
      },
      { title: "PE-1", data: snap(WIDE, rows), keyColumn: null },
    ]);
    // the RICH working tab owns the work; the narrow compilation is the copy
    expect(out.pureCopies).toEqual(new Set(["Line List"]));
    expect(out.freshByTab.get("PE-1")).toHaveLength(3);
  });

  it("same-width sheets keep position order (no behavior change where position was right)", () => {
    const H = ["SKU", "Qty"];
    const rows = [
      ["A-1", "1"],
      ["B-2", "2"],
    ];
    const out = dedupeTabData([
      { title: "First", data: snap(H, rows), keyColumn: null },
      {
        title: "Second",
        data: snap(
          H,
          rows.map((r) => [...r]),
        ),
        keyColumn: null,
      },
    ]);
    expect(out.pureCopies).toEqual(new Set(["Second"])); // first still wins
  });
});
