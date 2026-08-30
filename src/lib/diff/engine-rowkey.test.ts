/**
 * rowKey disambiguation coverage — the newest engine behavior, tested as
 * BEHAVIOR (not source text):
 *
 *   blank-keyed rows paired by content can be exact duplicates in A (padded
 *   tracker rows, repeated label rows). When BOTH siblings change in B, their
 *   rowKeys would both be the content hash of the SAME A row, so one ack
 *   (changeAcks is keyed by tab+rowKey) would resolve BOTH changes. The fix
 *   appends the A-side position: rowKey = baseRowKey + "#" + i.
 *
 * History worth guarding: an earlier attempt shipped the detection variable
 * (`needsDisambiguation`) but never wired the suffix — dead code describing an
 * unimplemented fix. A source-grep test cannot tell wired from dead; the
 * behavioral tests below can, and survive any refactor of the expression.
 *
 * The final it.fails documents the residual hole: emitRemoved has no
 * disambiguation, so two identical blank-key rows deleted together still
 * share one rowKey (one ack resolves both removals). When that ships, the
 * it.fails flips to "unexpectedly passed" and must be unmarked.
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
    // Two rows per side — composite detection needs ≥2 rows to engage.
    const ka = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "BIG M P1", ""],
      ["Bore", "500", "14800", "HAIDER 1", ""],
    ]);
    const kb = snap(TRACKER_HEADERS, [
      ["Plow", "0", "500", "BIG M P1", ""],
      ["Bore", "500", "14800", "HAIDER 2", ""],
    ]);
    const changed = diffSnapshots(ka, kb).rows.find((x) => x.status === "changed")!;
    expect(changed.rowKey).toBe("bore"); // the detected key column value, never "#i"
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

describe("rowKey disambiguation: residual hole in emitRemoved (documented, known-failing)", () => {
  it.fails("two identical blank-key rows deleted together get distinct rowKeys too", () => {
    // A has three identical padded rows; B replaces the family with different
    // content. One A row pairs positionally (changed), the other two are
    // removed — and today BOTH removals carry the same content-hash rowKey
    // (emitRemoved has no disambiguation), so one ack resolves both.
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
});
