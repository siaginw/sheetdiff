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

  it("present-mode rows are dated EXACTLY by the family-count threshold (the twin case), anchor or not", () => {
    // blank-key twins: the changed row's NEW content hash already exists in
    // the baseline as its sibling. A presence test of "content exists
    // anywhere" would date it at the anchor and let a stale ack swallow it;
    // the count threshold ("the family GREW by one vs the bounding snapshot")
    // dates it at the moment it grew — in BOTH anchored and unanchored walks.
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
    // exactly dated at the growth (2000), never at the baseline (1000)
    expect(anchored.get(changed!.rowKey)).toBe(2000);
    // unanchored: the walk never sees the pre-growth level, so the row is
    // left undated (strict fallback) — the re-flag direction, never a swallow
    expect(unanchored.has(changed!.rowKey)).toBe(false);
    // an ack BEFORE the growth must not resolve it — the stale-ack swallow
    const acks = new Map([[changed!.rowKey, 1500]]);
    expect(isResolved(acks, changed!.rowKey, anchored.get(changed!.rowKey)!)).toBe(false);
  });

  it("a family that shrinks and REGROWS dates the regrowth — a stale ack cannot swallow the re-addition (fleet-9)", () => {
    // 2 identical rows at baseline; grows to 3 (an addition), acked; shrinks
    // to 2; regrows to 3. Content-based presence ("one exists") sees the
    // family present throughout and dates the addition at the anchor — the
    // ack then covers the REGROWN row too. The count threshold dates the
    // regrowth at 5000, so the ack (2500) no longer resolves it.
    const NH = ["Name", "Qty"];
    const P = ["x", "55"];
    const baseline = snap(NH, [P, P]);
    const chain = [
      { at: 2000, data: snap(NH, [P, P, P]) }, // grew to 3
      { at: 3000, data: snap(NH, [P, P]) }, // shrank to 2
      { at: 4000, data: snap(NH, [P, P]) },
      { at: 5000, data: snap(NH, [P, P, P]) }, // REGROWN — new unentered work
      { at: 6000, data: snap(NH, [P, P, P]) },
    ];
    const latest = chain[chain.length - 1];
    const diff = diffSnapshots(baseline, latest.data);
    const added = diff.rows.find((r) => r.status === "added");
    expect(added).toBeDefined();
    const walk = [...chain].reverse().map((s) => ({ createdAt: s.at, data: s.data }));
    const intro = computeIntroductions([...walk, { createdAt: 1000, data: baseline }], diff.rows);
    expect(intro.get(added!.rowKey)).toBe(5000); // the regrowth, not the anchor
    expect(isResolved(new Map([[added!.rowKey, 2500]]), added!.rowKey, intro.get(added!.rowKey)!)).toBe(false);
    expect(isResolved(new Map([[added!.rowKey, 5500]]), added!.rowKey, intro.get(added!.rowKey)!)).toBe(true);
  });

  it("the baseline anchor is still load-bearing for blank-key REMOVALS: without it the family's pre-removal level is unknowable", () => {
    const NH = ["Name", "Qty"];
    const P = ["x", "55"];
    const baseline = snap(NH, [P, P, P]);
    const chain = [
      { at: 2000, data: snap(NH, [P]) }, // 2 removed
      { at: 3000, data: snap(NH, [P]) },
    ];
    const latest = chain[chain.length - 1];
    const diff = diffSnapshots(baseline, latest.data);
    const walk = [...chain].reverse().map((s) => ({ createdAt: s.at, data: s.data }));
    // anchored: the walk sees the baseline's level 3 and dates the drop at 2000
    const anchored = computeIntroductions([...walk, { createdAt: 1000, data: baseline }], diff.rows);
    const removed = diff.rows.find((r) => r.status === "removed")!;
    expect(anchored.get(removed.rowKey)).toBe(2000);
    expect(isResolved(new Map([[removed.rowKey, 2500]]), removed.rowKey, anchored.get(removed.rowKey)!)).toBe(true);
    // unanchored: the oldest walked snapshot already shows level 1 — the
    // removal looks like it predates the window and the row is left undated
    // (strict fallback: unresolved until re-acked)
    const unanchored = computeIntroductions(walk, diff.rows);
    expect(unanchored.has(removed.rowKey)).toBe(false);
  });
});

describe("keySetsFor (identity column hardening)", () => {
  const TH = ["Activity", "Start STA", "End STA", "Crew"];
  it("builds composite identity sets when headers agree across the walk", async () => {
    const baseline = snap(TH, [["Plow", "0", "500", "A"], ["Bore", "500", "14800", "B"], ["Plow", "14800", "15743", "C"]]);
    const chain = [{ at: 2000, data: snap(TH, [["Plow", "0", "500", "A"], ["Plow", "14800", "15743", "C"]]) }]; // bore removed (composite needs >=2 rows in B)
    const latest = chain[chain.length - 1];
    const diff = diffSnapshots(baseline, latest.data); // composite engages
    expect(diff.identityColumns).toEqual([0, 1, 2]);
    const walk = [...chain].reverse().map((s) => ({ createdAt: s.at, data: s.data }));
    const anchored = [...walk, { createdAt: 1000, data: baseline }];
    const keySets = keySetsFor(diff, anchored)!;
    expect(keySets).toHaveLength(2); // chain + baseline anchor
    expect(keySets[0]!.has("bore·500·14800")).toBe(false); // removed in the window
    expect(keySets[1]!.has("bore·500·14800")).toBe(true); // present at the baseline
    // the removed row dates at the row's disappearance
    const intro = computeIntroductions(anchored, diff.rows, { keySets });
    const removed = diff.rows.find((r) => r.status === "removed")!;
    expect(intro.get(removed.rowKey)).toBe(2000);
  });

  it("bails to undefined when a walked snapshot's headers drift at the identity indices", () => {
    const latest = snap(TH, [["Plow", "0", "500", "A"], ["Bore", "500", "14800", "B"]]);
    const diff = diffSnapshots(latest, latest);
    // a mid-window snapshot where a column was inserted at index 0
    const drifted = { createdAt: 2000, data: snap(["Note", "Activity", "Start STA", "End STA", "Crew"], [["n", "Plow", "0", "500", "A"]]) };
    const walk = [{ createdAt: 3000, data: latest }, drifted];
    expect(keySetsFor(diff, walk)).toBeUndefined();
  });
});
