import { describe, it, expect } from "vitest";
import { computeIntroductions, isResolved } from "./sync";
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
  return { diff, intro: computeIntroductions(walk, diff.rows) };
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
});
