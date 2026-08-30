import { describe, it, expect } from "vitest";
import { buildBillingPacket, billingPacketCsv, quietTabs } from "./billing";
import type { AgingGap, LateEntry } from "./production";

describe("buildBillingPacket", () => {
  it("assembles footage, holes, to-enter, and late rows with summary counts", () => {
    const holes: AgingGap[] = [
      { from: 500, to: 620, ft: 120, firstSeen: 1, lastSeen: 2, daysOpen: 5 },
    ];
    const late: LateEntry[] = [
      { row: 3, completedOn: "7/13/2026", appearedAt: 2, daysLate: 4, activity: "Plow" },
    ];
    const p = buildBillingPacket({
      sinceFt: 5280,
      holes,
      unresolved: [
        { status: "changed", key: "1", rowKey: "1", oldIndex: 0, newIndex: 0, movedFrom: null, cells: [{ col: 2, header: "Qty", from: "40", to: "55" }], values: ["1", "Plow", "55"] },
      ] as never[],
      lateEntries: late,
      snapshotLabel: "Aug 29 4:00 PM",
    });
    expect(p.placedSinceFt).toBe(5280);
    expect(p.openHoleFt).toBe(120);
    expect(p.toEnterCount).toBe(1);
    expect(p.rows[0]).toMatchObject({ kind: "footage", ft: 5280 });
    expect(p.rows[1]).toMatchObject({ kind: "hole", ft: 120 });
    expect(p.rows[2]).toMatchObject({ kind: "to-enter" });
    expect(p.rows[3]).toMatchObject({ kind: "late" });
  });

  it("CSV carries provenance stamps and neutralizes commas", () => {
    const p = buildBillingPacket({
      sinceFt: 100,
      holes: [],
      unresolved: [],
      lateEntries: [],
      snapshotLabel: "Test, with comma",
      now: new Date("2026-08-30").getTime(),
    });
    const csv = billingPacketCsv(p);
    expect(csv.startsWith("# SheetDiff billing packet")).toBe(true);
    expect(csv).toContain('Test, with comma');
    expect(csv.split("\n")[0]).toMatch(/^#/);
  });
});

describe("quietTabs", () => {
  it("flags tabs silent past the threshold, sorted oldest first", () => {
    const now = Date.now();
    const flagged = quietTabs(
      [
        { title: "PE-001", lastNewRowAt: now - 6 * 86_400_000 },
        { title: "PE-002", lastNewRowAt: now - 10 * 86_400_000 },
        { title: "PE-003", lastNewRowAt: now - 1 * 86_400_000 }, // fresh
        { title: "PE-004", lastNewRowAt: null }, // never — excluded
      ],
      now,
    );
    expect(flagged.map((t) => t.title)).toEqual(["PE-002", "PE-001"]);
    expect(flagged[0]!.days).toBe(10);
  });
});
