import { describe, it, expect } from "vitest";
import { computeIntroductions, isResolved, keySetsFor } from "./sync";
import { diffSnapshots, type SnapshotData } from "./diff/engine";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });
const H = ["ID", "Qty"];

function introductionsBetween(baseline: SnapshotData, chain: { at: number; data: SnapshotData }[]) {
  const latest = chain[chain.length - 1];
  const diff = diffSnapshots(baseline, latest.data, { keyColumn: 0 });
  // walk = newest → oldest, WITH the baseline as the final bounding entry —
  // the contract pending.ts uses: a row cannot predate the window the diff
  // spans, so every introduction comes out exact
  const walk = [...chain].reverse().map((s) => ({ createdAt: s.at, data: s.data }));
  walk.push({ createdAt: 1000, data: baseline });
  return { diff, intro: computeIntroductions(walk, diff.rows, { keySets: keySetsFor(diff, walk) }) };
}

describe("computeIntroductions", () => {
  it("dates a change at the snapshot where the content first appeared, not the latest", () => {
    const baseline = snap(H, [["1", "40"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "55"]]) }, // change introduced here
      { at: 3000, data: snap(H, [["1", "55"]]) }, // later snapshot, same content
      { at: 4000, data: snap(H, [["1", "55"]]) }, // another one, same content
    ];
    const { intro } = introductionsBetween(baseline, chain);
    expect(intro.get("1")).toBe(2000);
  });

  it("an ack between introduction and latest stays resolved (the bug fix)", () => {
    const baseline = snap(H, [["1", "40"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "55"]]) },
      { at: 4000, data: snap(H, [["1", "55"]]) },
    ];
    const { intro } = introductionsBetween(baseline, chain);
    const acks = new Map([["1", 2500]]); // acked after introduction, before latest
    expect(isResolved(acks, "1", intro.get("1")!)).toBe(true);
  });

  it("re-changed rows flag as unresolved again", () => {
    const baseline = snap(H, [["1", "40"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "55"]]) },
      { at: 4000, data: snap(H, [["1", "77"]]) }, // changed AGAIN after the ack
    ];
    const { intro } = introductionsBetween(baseline, chain);
    const acks = new Map([["1", 2500]]);
    expect(isResolved(acks, "1", intro.get("1")!)).toBe(false);
    expect(intro.get("1")).toBe(4000);
  });

  it("dates added rows at their first appearance and removals at their disappearance", () => {
    const baseline = snap(H, [["1", "40"], ["2", "10"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "40"]]) }, // "2" removed here
      { at: 3000, data: snap(H, [["1", "40"], ["3", "99"]]) }, // "3" added here
      { at: 4000, data: snap(H, [["1", "40"], ["3", "99"]]) },
    ];
    const { intro, diff } = introductionsBetween(baseline, chain);
    expect(intro.get("2")).toBe(2000); // removed at 2000
    expect(intro.get("3")).toBe(3000); // added at 3000
    expect(diff.rows.find((r) => r.key === "2")?.status).toBe("removed");
    expect(diff.rows.find((r) => r.key === "3")?.status).toBe("added");
  });

  it("emits NO entry when the row mismatches the newest walked snapshot (falls back to caller default)", () => {
    // baseline has "1"=40; the only walked snapshot is OLDER content the diff
    // never saw — walk[0] mismatches immediately, so no introduction is dated
    const baseline = snap(H, [["1", "40"]]);
    const latest = snap(H, [["1", "77"]]);
    const diff = diffSnapshots(baseline, latest, { keyColumn: 0 });
    const walk = [{ createdAt: 5000, data: snap(H, [["1", "55"]]) }]; // not the latest content
    const intro = computeIntroductions(walk, diff.rows);
    expect(intro.has("1")).toBe(false);
    // callers treat "no entry" as introduced-at-the-to-snapshot: an ack taken
    // BEFORE that change must stay unresolved
    const acks = new Map([["1", 4000]]);
    expect(isResolved(acks, "1", 5001)).toBe(false);
  });

  it("a re-change hidden below a shallow walk's reach is still dated exactly (fleet-7 false-miss regression)", () => {
    // 35 snapshots: the row changes right after the baseline, is acked, then
    // RE-CHANGES one snapshot later; everything above is quiet. A capped walk
    // that treats the unbounded row as "introduced unknown → any ack counts"
    // would let the old ack silently swallow the re-change. The baseline
    // anchor dates it exactly, so the re-change stays unresolved.
    const baseline = snap(H, [["1", "40"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "55"]]) }, // 40 -> 55
      { at: 3000, data: snap(H, [["1", "77"]]) }, // 55 -> 77 AFTER the ack — the miss risk
      ...Array.from({ length: 33 }, (_, i) => ({ at: 4000 + i * 1000, data: snap(H, [["1", "77"]]) })),
    ];
    const { intro } = introductionsBetween(baseline, chain);
    expect(intro.get("1")).toBe(3000);
    const acks = new Map([["1", 2500]]); // acked against 55, before the re-change
    expect(isResolved(acks, "1", intro.get("1")!)).toBe(false);
  });

  it("an ack older than the walk's reach on a never-re-changed row stays resolved (the fleet-6 nag case)", () => {
    // the row changed once right after the baseline and was acked; 40 quiet
    // snapshots follow. Dating the row at the oldest WALKED snapshot would
    // postdate the ack and re-flag entered work every single day.
    const baseline = snap(H, [["1", "40"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "55"]]) },
      ...Array.from({ length: 40 }, (_, i) => ({ at: 3000 + i * 1000, data: snap(H, [["1", "55"]]) })),
    ];
    const { intro } = introductionsBetween(baseline, chain);
    expect(intro.get("1")).toBe(2000); // bounded by the baseline anchor, not the walk's edge
    const acks = new Map([["1", 2500]]);
    expect(isResolved(acks, "1", intro.get("1")!)).toBe(true);
  });

  it("a DELETION after a change is NOT swallowed by the change's ack (fleet-8: the removed row tracks ROW existence)", () => {
    // baseline k=40 → changed to 55 → ACKED → row deleted. The removal is new
    // work (remove it downstream too); dating it at when "40" left the sheet
    // (the change) let the change's ack swallow the deletion — a silent miss.
    const baseline = snap(H, [["1", "40"]]);
    const chain = [
      { at: 2000, data: snap(H, [["1", "55"]]) }, // change
      { at: 3000, data: snap(H, [["1", "55"]]) },
      { at: 4000, data: snap(H, []) }, // DELETED here
      { at: 5000, data: snap(H, []) },
    ];
    const { diff, intro } = introductionsBetween(baseline, chain);
    expect(diff.rows.find((r) => r.status === "removed")).toBeDefined();
    expect(intro.get("1")).toBe(4000); // the deletion, not the 2000 change
    const acks = new Map([["1", 2500]]); // acked the change only
    expect(isResolved(acks, "1", intro.get("1")!)).toBe(false); // deletion still to enter
    // ...and an ack taken AFTER the deletion resolves it
    expect(isResolved(new Map([["1", 4500]]), "1", intro.get("1")!)).toBe(true);
  });

  it("identical-blank-key removals stay dated at the family's count drop (the padding whack-a-mole)", () => {
    // 3 identical padding rows at baseline; 2 go away at 2000; quiet tail.
    // The old content-hash walk saw the survivor and re-flagged the removal
    // after EVERY capture; the count-based walk dates the drop once, so an
    // ack after it holds forever.
    const P = ["", "", "", "", "ZONE 2"];
    const baseline = snap(["Activity", "Start STA", "End STA", "Crew", "Notes"], [P, P, P]);
    const chain = [
      { at: 2000, data: snap(["Activity", "Start STA", "End STA", "Crew", "Notes"], [P]) },
      ...Array.from({ length: 20 }, (_, i) => ({ at: 3000 + i * 1000, data: snap(["Activity", "Start STA", "End STA", "Crew", "Notes"], [P]) })),
    ];
    const { diff, intro } = introductionsBetween(baseline, chain);
    const removed = diff.rows.filter((r) => r.status === "removed");
    expect(removed).toHaveLength(2);
    for (const r of removed) {
      expect(intro.get(r.rowKey)).toBe(2000); // dated at the count drop — stable
      expect(isResolved(new Map([[r.rowKey, 2500]]), r.rowKey, intro.get(r.rowKey)!)).toBe(true);
    }
  });

  it("the baseline anchor is load-bearing: without it, a change whose content pre-exists in the baseline re-flags forever", () => {
    // blank-key twins: the changed row's NEW content hash already exists in
    // the baseline as its sibling (padded trackers have hundreds of these).
    // Anchored, the row is introduced AT the baseline and an ack after it
    // resolves; unanchored, the walk's oldest edge postdates the ack and it
    // re-flags on every capture.
    const NH = ["Name", "Qty"];
    const baseline = snap(NH, [["x", "40"], ["x", "55"]]);
    const chain = [
      { at: 2000, data: snap(NH, [["x", "55"], ["x", "55"]]) }, // row 0 became a twin of row 1
      ...Array.from({ length: 5 }, (_, i) => ({ at: 3000 + i * 1000, data: snap(NH, [["x", "55"], ["x", "55"]]) })),
    ];
    const latest = chain[chain.length - 1];
    const diff = diffSnapshots(baseline, latest.data); // no key column — content matching
    const changed = diff.rows.find((r) => r.status === "changed");
    expect(changed).toBeDefined();
    const walk = [...chain].reverse().map((s) => ({ createdAt: s.at, data: s.data }));
    const anchored = computeIntroductions([...walk, { createdAt: 1000, data: baseline }], diff.rows);
    const unanchored = computeIntroductions(walk, diff.rows);
    const acks = new Map([[changed!.rowKey, 1500]]); // ack between baseline and the walk's oldest edge
    expect(isResolved(acks, changed!.rowKey, anchored.get(changed!.rowKey)!)).toBe(true); // 1000 <= 1500
    expect(isResolved(acks, changed!.rowKey, unanchored.get(changed!.rowKey)!)).toBe(false); // 2000 > 1500 — the nag
  });
});
