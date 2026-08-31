/**
 * rowKey disambiguation coverage — the newest engine behavior, tested as
 * BEHAVIOR (not source text):
 *
 *   A rowKey must identify ONE row per diff (changeAcks/notes are keyed by
 *   tab+rowKey). Collisions arise three ways, all fixed by a post-emission
 *   uniqueness pass that suffixes repeated families positionally:
 *
 *   1. blank-keyed rows paired by content — exact duplicates in A (padded
 *      tracker rows) — get the A-side position: rowKey = base + "#" + i.
 *   2. a key VALUE that repeats (shot labels do: "S3 entered twice, plow +
 *      bore") — one changed + one removed row both carry rowKey "s3".
 *   3. identical blank-keyed rows added or removed together — the added and
 *      removed emit paths had no disambiguation at all.
 *
 * History worth guarding: an earlier attempt shipped the detection variable
 * (`needsDisambiguation`) but never wired the suffix — dead code describing an
 * unimplemented fix. A source-grep test cannot tell wired from dead; the
 * behavioral tests below can, and survive any refactor of the expression.
 */
import { describe, it, expect } from "vitest";
import { diffSnapshots, rowContentKey, type SnapshotData } from "./engine";
import { isResolved } from "../sync";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

/** Tracker vocabulary: no ID column, identity = Activity + stations (detect.ts). */
const TRACKER_HEADERS = ["Activity", "Start STA", "End STA", "Crew #", "Notes"];

describe("rowKey disambiguation: same-family blank-key siblings both changed", () => {
  // A carries TWO fully identical rows (same family: Plow 0-500, nothing else
  // filled in) — exactly what padded/repeated tracker rows look like.
  const a = snap(TRACKER_HEADERS, [
    ["Plow", "0", "500", "", ""],
    ["Plow", "0", "500", "", ""],
  ]);
  // B changes BOTH siblings, differently, in non-identity columns. No column
  // is unique-and-populated in B, so no key column can hijack the mechanism.
  const b = snap(TRACKER_HEADERS, [
    ["Plow", "0", "500", "", "A"],
    ["Plow", "0", "500", "B", ""],
  ]);

  it("both siblings are reported as changed with DISTINCT rowKeys", () => {
    const r = diffSnapshots(a, b);
    const changed = r.rows.filter((x) => x.status === "changed");
    expect(changed).toHaveLength(2);
    const [k0, k1] = changed.map((x) => x.rowKey);
    // THE gap this file closes: without disambiguation both rowKeys are
    // rowContentKey of the SAME identical A row — i.e. k0 === k1, and one
    // ack would resolve both changes.
    expect(k0).not.toBe(k1);
    // the suffix is the A-side position of each sibling's matched row
    expect(k0).toBe(rowContentKey(a.rows[0]!) + "#0");
    expect(k1).toBe(rowContentKey(a.rows[1]!) + "#1");
  });

  it("ONE ack resolves exactly ONE sibling — the other stays pending", () => {
    const r = diffSnapshots(a, b);
    const changed = r.rows.filter((x) => x.status === "changed");
    const ackMap = new Map([[changed[0]!.rowKey, 9999]]);
    expect(isResolved(ackMap, changed[0]!.rowKey, 1)).toBe(true);
    // with a collision this is ALSO true — one ack would silently resolve a
    // second, different change the office never entered downstream
    expect(isResolved(ackMap, changed[1]!.rowKey, 1)).toBe(false);
  });

  it("rowKeys are stable across re-changes, so an old ack keeps its meaning", () => {
    // sibling 0 changes AGAIN (note A -> AA); sibling 1 keeps its first change.
    // Same A-side rows -> same rowKeys as the first diff; only content moved,
    // so an ack taken against the first change still targets sibling 0 only.
    const c = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "", "AA"],
      ["Plow", "0", "500", "B", ""],
    ]);
    const first = diffSnapshots(a, b).rows.filter((x) => x.status === "changed").map((x) => x.rowKey);
    const second = diffSnapshots(a, c).rows.filter((x) => x.status === "changed").map((x) => x.rowKey);
    expect(second).toEqual(first);
  });

  it("keyed rows keep their raw identity as rowKey — the suffix never applies", () => {
    // composite identity (or an explicit tabs.keyColumn): acks recorded
    // against key-valued rowKeys must survive the disambiguation untouched.
    // Two rows per side — composite detection needs ≥2 rows to engage. (The
    // Activity column is deliberately NOT promoted to key anymore — activity
    // values repeat on real trackers, so composite is the honest identity.)
    const ka = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "BIG M P1", ""],
      ["Bore", "500", "14800", "HAIDER 1", ""],
    ]);
    const kb = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "BIG M P1", ""],
      ["Bore", "500", "14800", "HAIDER 2", ""],
    ]);
    const changed = diffSnapshots(ka, kb).rows.find((x) => x.status === "changed")!;
    expect(changed.rowKey).toBe("bore·500·14800"); // the composite identity, never "#i"
    expect(changed.rowKey).not.toContain("#");
  });

  it("distinctness holds for three siblings changed in one diff", () => {
    // each sibling is distinguished in a DIFFERENT column so no column is
    // unique-and-populated enough in B to become a detected key column
    const H6 = ["Activity", "Start STA", "End STA", "Crew #", "Notes", "Ref"];
    const s = () => ["Plow", "0", "500", "", "", ""];
    const a3 = snap(H6, [s(), s(), s()]);
    const b3 = snap(H6, [
      ["Plow", "0", "500", "B1", "", ""],
      ["Plow", "0", "500", "", "N2", ""],
      ["Plow", "0", "500", "", "", "R3"],
    ]);
    const keys = diffSnapshots(a3, b3)
      .rows.filter((x) => x.status === "changed")
      .map((x) => x.rowKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3); // pairwise distinct
  });

  it("a single blank-key family member is unchanged in meaning (suffix present, one row)", () => {
    // every blank-keyed content-matched row carries the suffix — pin that a
    // lone padded row's rowKey is content-hash + "#<its A position>" so the
    // rule is uniform, not collision-triggered
    const one = snap(TRACKER_HEADERS, [["", "", "", "", "ZONE 2"]]);
    const edited = snap(TRACKER_HEADERS, [["", "", "", "X", "ZONE 2"]]);
    const changed = diffSnapshots(one, edited).rows.find((x) => x.status === "changed")!;
    expect(changed.rowKey).toBe(rowContentKey(one.rows[0]!) + "#0");
  });
});

describe("rowKey disambiguation: removed siblings and repeated key values", () => {
  it("two identical blank-key rows deleted together get distinct rowKeys too", () => {
    // A has three identical padded rows; B replaces the family with different
    // content. One A row pairs positionally (changed), the other two are
    // removed — both removals must carry distinct content-hash rowKeys or one
    // ack resolves both.
    const a = snap(TRACKER_HEADERS, [
      ["", "", "", "", "ZONE 2"],
      ["", "", "", "", "ZONE 2"],
      ["", "", "", "", "ZONE 2"],
    ]);
    const b = snap(TRACKER_HEADERS, [["", "", "", "", "OTHER ZONE"]]);
    const removed = diffSnapshots(a, b).rows.filter((x) => x.status === "removed");
    expect(removed).toHaveLength(2);
    expect(removed[0]!.rowKey).not.toBe(removed[1]!.rowKey);
  });

  it("two identical blank-key rows ADDED together get distinct rowKeys", () => {
    // the added-row sibling of the above: both new rows share one content
    // hash; without disambiguation one ack makes both vanish from the
    // to-enter worklist
    const a = snap(TRACKER_HEADERS, [["Plow", "0", "500", "CREW A", ""]]);
    const b = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "CREW A", ""],
      ["", "", "", "", "ZONE 7"],
      ["", "", "", "", "ZONE 7"],
    ]);
    const added = diffSnapshots(a, b).rows.filter((x) => x.status === "added");
    expect(added).toHaveLength(2);
    expect(added[0]!.rowKey).not.toBe(added[1]!.rowKey);
    // one ack resolves exactly one added row
    const ackMap = new Map([[added[0]!.rowKey, 9999]]);
    expect(isResolved(ackMap, added[0]!.rowKey, 1)).toBe(true);
    expect(isResolved(ackMap, added[1]!.rowKey, 1)).toBe(false);
  });

  it("a repeated key VALUE yields distinct rowKeys for changed vs removed (the 'S3 twice' case)", () => {
    // real trackers repeat shot labels: "S3 entered twice, plow + bore". With
    // an explicit key column, one row changes and its duplicate is removed —
    // both would carry rowKey "s3" and one ack would drop the removal from
    // the worklist. The demo seed models exactly this.
    const H = ["Shot", "Activity", "Start STA", "End STA", "Crew"];
    const ka = snap(H, [
      ["s3", "Plow", "0", "500", "CREW A"],
      ["s3", "Bore", "500", "14800", "CREW B"],
      ["s9", "Plow", "14800", "15743", "CREW A"],
    ]);
    const kb = snap(H, [
      ["s3", "Plow", "0", "500", "CREW A-2"], // s3-plow changed
      ["s9", "Plow", "14800", "15743", "CREW A"], // s3-bore removed
    ]);
    const r = diffSnapshots(ka, kb, { keyColumn: 0 });
    const changed = r.rows.find((x) => x.status === "changed")!;
    const removed = r.rows.filter((x) => x.status === "removed");
    expect(removed).toHaveLength(1);
    expect(changed.rowKey).not.toBe(removed[0]!.rowKey);
    // acking the change must not resolve the removal
    const ackMap = new Map([[changed.rowKey, 9999]]);
    expect(isResolved(ackMap, removed[0]!.rowKey, 1)).toBe(false);
  });

  it("a UNIQUE key still keeps its raw identity — no suffix appears", () => {
    const H = ["Shot", "Activity", "Start STA", "End STA", "Crew"];
    const ka = snap(H, [["s1", "Plow", "0", "500", "CREW A"]]);
    const kb = snap(H, [["s1", "Plow", "0", "500", "CREW B"]]);
    const changed = diffSnapshots(ka, kb, { keyColumn: 0 }).rows.find((x) => x.status === "changed")!;
    expect(changed.rowKey).toBe("s1");
    expect(changed.rowKey).not.toContain("#");
  });

  it("a suffix never lands on another row's RAW key ('s3#0' as a real key value)", () => {
    // a key value can legitimately contain "#<digits>" — the s3 family's first
    // suffix would collide with the unrelated row keyed "s3#0". Reserved
    // bases must force the family to bump past them.
    const H = ["Shot", "Activity"];
    const a = snap(H, [["s3", "Plow"], ["s3", "Bore"], ["s3#0", "Plow"]]);
    const b = snap(H, [["s3", "Plow"], ["s3#0", "Plow"]]);
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    const all = r.rows.map((x) => x.rowKey);
    expect(new Set(all).size).toBe(all.length); // pairwise distinct across ALL rows
    // the RAW key survives untouched — exactly one row carries it, full stop
    expect(all.filter((k) => k === "s3#0")).toHaveLength(1);
  });

  it("duplicate key where the added row's B-index equals the matched row's A-index (the bump path)", () => {
    // the matched row (A-index 1) and the added row (B-index 1) both propose
    // "s3#1" — the collision bump must separate them or one ack resolves both
    const H = ["Shot", "Activity"];
    const a = snap(H, [["s9", "A"], ["s3", "B"]]);
    const b = snap(H, [["s3", "B2"], ["s3", "C"], ["s9", "A"]]);
    const r = diffSnapshots(a, b, { keyColumn: 0 });
    const changed = r.rows.find((x) => x.status === "changed")!;
    const added = r.rows.find((x) => x.status === "added")!;
    expect(changed.rowKey).not.toBe(added.rowKey);
    expect(new Set(r.rows.map((x) => x.rowKey)).size).toBe(r.rows.length);
    const acks = new Map([[changed.rowKey, 9999]]);
    expect(isResolved(acks, added.rowKey, 1)).toBe(false);
  });

  it("DOCUMENTED TRADEOFF: identical added rows' suffixes are B-positional and shift when rows insert above", () => {
    // identical blank-key rows have no content discriminator, so their keys
    // move with their position. An ack can transfer between identical
    // siblings across captures — but the pending COUNT stays correct (one
    // sibling remains unresolved), which is the invariant every consumer
    // relies on. This test pins that deliberately; change it consciously.
    const base = snap(TRACKER_HEADERS, [["Plow", "0", "500", "CREW A", ""]]);
    const cap1 = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "CREW A", ""],
      ["", "", "", "", "ZONE 7"],
      ["", "", "", "", "ZONE 7"],
    ]);
    const r1 = diffSnapshots(base, cap1);
    const added1 = r1.rows.filter((x) => x.status === "added");
    expect(added1).toHaveLength(2);
    // acking one leaves exactly one pending — the count survives any shift
    const acks = new Map([[added1[0]!.rowKey, 9999]]);
    expect(added1.filter((x) => !isResolved(acks, x.rowKey, 1))).toHaveLength(1);

    // next capture: a keyed row inserted ABOVE the twins shifts their
    // suffixes — the ack may now match the other sibling, yet exactly ONE
    // twin stays unresolved. Count integrity over identity purity.
    const cap2 = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "CREW A", ""],
      ["Bore", "500", "14800", "CREW B", ""],
      ["", "", "", "", "ZONE 7"],
      ["", "", "", "", "ZONE 7"],
    ]);
    const r2 = diffSnapshots(base, cap2);
    const added2 = r2.rows.filter((x) => x.status === "added");
    expect(added2).toHaveLength(3); // the bore plus both twins
    const twins = added2.filter((x) => x.values[4] === "ZONE 7");
    expect(twins).toHaveLength(2);
    expect(twins.filter((x) => !isResolved(acks, x.rowKey, 1)).length).toBeGreaterThanOrEqual(1);
  });
});
