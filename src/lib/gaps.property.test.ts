import { describe, it, expect } from "vitest";
import { computeGapReport } from "./gaps";
import type { SnapshotData } from "./diff/engine";

/** Property test: randomized chains must always satisfy the gap-report
 *  invariants — the class of bug where overlap ft disagreed with its own
 *  from/to was found by review; this makes the whole family impossible. */

const H = ["Activity", "Start STA", "End STA"];
const snap = (rows: string[][]): SnapshotData => ({ headers: H, rows });

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("computeGapReport invariants (property)", () => {
  it("reconciles and self-agrees across 300 random chains", () => {
    const rnd = mulberry32(20260830);
    for (let iter = 0; iter < 300; iter++) {
      const rows: string[][] = [];
      let cursor = 0;
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.1) {
          rows.push(["48 Handhole", String(cursor), String(cursor)]); // zero-length
          continue;
        }
        if (rnd() < 0.1) {
          rows.push(["Cobble Adder", String(cursor), String(cursor + 50)]); // billing overlay
          continue;
        }
        const len = 1 + Math.floor(rnd() * 400);
        const roll = rnd();
        if (roll < 0.25 && cursor > 0) {
          cursor += 1 + Math.floor(rnd() * 100); // unbooked hole
        } else if (roll < 0.4 && cursor > 0) {
          rows.push(["GAP", String(cursor), String(cursor + len)]); // booked, frontier-only
          cursor += len;
          continue;
        }
        const back = roll < 0.7 ? 0 : 1 + Math.floor(rnd() * Math.min(len, cursor || 1));
        const start = Math.max(0, cursor - back);
        rows.push([rnd() < 0.5 ? "Plow" : "Bore", String(start), String(start + len)]);
        cursor = Math.max(cursor, start + len);
      }
      if (rnd() < 0.3) rows.reverse(); // appended corrections arrive out of order

      const r = computeGapReport(snap(rows));
      if (r.chainStart === null) continue;

      for (const s of [...r.knownGaps, ...r.unaccounted, ...r.overlaps]) {
        expect(s.ft, `segment ft must equal to−from: ${JSON.stringify(s)}`).toBe(s.to - s.from);
      }
      const accounted =
        r.placedFt +
        r.knownGaps.reduce((a, g) => a + g.ft, 0) +
        r.unaccounted.reduce((a, g) => a + g.ft, 0) -
        r.overlaps.reduce((a, g) => a + g.ft, 0);
      expect(accounted, `chain ${JSON.stringify(rows)}`).toBe(r.designedSpan);
      for (const g of r.unaccounted) {
        expect(g.from).toBeGreaterThanOrEqual(r.chainStart!);
        expect(g.to).toBeLessThanOrEqual(r.chainEnd!);
      }
    }
  });
});
