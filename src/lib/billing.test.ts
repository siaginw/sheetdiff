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

  it("quotes comma fields so the formula guard cannot be split off (regression, twice now)", () => {
    // a tab title or cell containing ",=formula" must stay ONE field: an
    // unquoted comma splits it and the unguarded remainder executes in Excel.
    // This exact quoting has regressed twice — the test is the guard.
    const p = buildBillingPacket({
      sinceFt: 0,
      holes: [{ from: 100, to: 200, ft: 100, firstSeen: 1, lastSeen: 2, daysOpen: 3, tab: "Bore Log,=2+5" }],
      unresolved: [
        {
          status: "added",
          values: ["plain,=SUM(1+1)"],
          cells: [],
        },
      ],
      lateEntries: [],
      snapshotLabel: "x",
      now: 1,
    });
    const csv = billingPacketCsv(p);
    const holeLine = csv.split("\n").find((l) => l.startsWith("hole,"))!;
    const enterLine = csv.split("\n").find((l) => l.startsWith("to-enter,"))!;
    // quote-aware field count stays 4 — a naive comma split would see 5+
    const fields = (line: string) => {
      const out: string[] = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (q && ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { q = !q; continue; }
        if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
        cur += ch;
      }
      out.push(cur);
      return out;
    };
    expect(fields(holeLine)).toHaveLength(4);
    expect(fields(enterLine)).toHaveLength(4);
    // the comma-bearing value stays ONE inert field (the prose prefix means
    // the formula guard cannot fire here — quoting is the only protection)
    expect(fields(holeLine)[3]!).toBe("do not invoice — unbooked footage (Bore Log,=2+5)");
    expect(fields(enterLine)[1]!).toBe("NEW row: plain,=SUM(1+1)");
  });

  it("flags over-placed packages as do-not-invoice rows in the packet and CSV", () => {
    const p = buildBillingPacket({
      sinceFt: 100,
      holes: [],
      unresolved: [],
      lateEntries: [],
      overplacement: [{ tabTitle: "US2-PE-002", designed: 52041, placed: 52994, overBy: 953 }],
      snapshotLabel: "Aug 29 4:00 PM",
      now: 1,
    });
    const over = p.rows.find((r) => r.kind === "over")!;
    expect(over.detail).toContain("US2-PE-002");
    expect(over.ft).toBe(953); // the excess is the number the office needs
    expect(over.meta).toMatch(/do not invoice/i);
    const csv = billingPacketCsv(p);
    // detail carries a thousands-separator comma, so it ships as ONE quoted field
    expect(csv).toContain('over,"US2-PE-002: placed 52,994 ft vs 52,041 ft designed",953,');
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
