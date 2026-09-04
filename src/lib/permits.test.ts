import { describe, expect, it } from "vitest";
import type { SnapshotData } from "./diff/engine";
import { buildPermitIndex, detectPermitTab, isPermitTabTitle, permitFindings, permitIsApproved } from "./permits";

const snap = (headers: string[], rows: string[][]): SnapshotData => ({ headers, rows });

const TRACKER = snap(
  ["Permit #", "Status", "Agency", "Submitted"],
  [
    ["PERM-101", "Approved", "City of Springfield", "5/2/2026"],
    ["PERM-102", "In Review", "City of Springfield", "6/1/2026"],
    ["PERM-103", "", "Sangamon County", "5/20/2026"], // no status — not approved
    ["", "Approved", "Nowhere", "1/1/2026"], // no permit number — skipped
  ],
);

const NOW = Date.UTC(2026, 7, 30); // late August 2026

describe("detectPermitTab", () => {
  it("matches title AND permit vocabulary headers", () => {
    const t = { title: "Permit Tracker", data: TRACKER };
    expect(detectPermitTab([t])).toBe(t);
    expect(isPermitTabTitle("permit tracker")).toBe(true);
    expect(isPermitTabTitle("PE-4")).toBe(false);
  });

  it("rejects a permit-titled tab without the vocabulary (headers keep the join honest)", () => {
    expect(detectPermitTab([{ title: "Permit Tracker", data: snap(["Date", "Notes"], []) }])).toBeNull();
    expect(detectPermitTab([{ title: "PE-4", data: TRACKER }])).toBeNull();
  });
});

describe("buildPermitIndex / permitIsApproved", () => {
  it("keys by permit number (case-insensitive) with status, agency and submitted date", () => {
    const idx = buildPermitIndex(TRACKER);
    expect(idx.size).toBe(3);
    const rec = idx.get("perm-101")!;
    expect(rec.status).toBe("Approved");
    expect(rec.agency).toBe("City of Springfield");
    expect(rec.submittedOn?.getMonth()).toBe(4); // May
  });

  it("approved vocabulary: Approved/Issued/Released pass; blank, In Review, Pending do not", () => {
    expect(permitIsApproved("Approved")).toBe(true);
    expect(permitIsApproved("Issued")).toBe(true);
    expect(permitIsApproved("Released")).toBe(true);
    expect(permitIsApproved("In Review")).toBe(false);
    expect(permitIsApproved("Pending")).toBe(false);
    expect(permitIsApproved("")).toBe(false); // absence of status can't wave work through
  });
});

describe("permitFindings", () => {
  const TOTALS = snap(
    ["Package", "Total Conduit Designed", "Total Conduit Placed", "Permit #"],
    [
      ["PE-4", "4,500", "1,200", "PERM-101"], // designed WITH a permit — fine
      ["PE-5", "2,000", "0", ""], // designed, no permit listed -> finding
      ["PE-6", "", "", ""], // nothing designed — skipped
    ],
  );

  it("flags designed footage with no permit, placed-under-unapproved, and aging submissions", () => {
    const pe = {
      title: "PE-4",
      data: snap(
        ["Activity", "Start STA", "End STA", "Date Complete", "Permit Package"],
        [
          ["Plow", "0", "500", "8/20/2026", "PERM-101"], // approved — fine
          ["Bore", "500", "900", "8/21/2026", "PERM-102"], // placed under In Review -> finding
          ["Bore", "900", "1200", "8/22/2026", "PERM-999"], // not in the tracker -> finding
          ["Plow", "1200", "1500", "", "PERM-102"], // not placed yet — skipped
          ["Plow", "1500", "1700", "8/23/2026", ""], // untagged — TOTALS finding's job
        ],
      ),
    };
    const out = permitFindings({ permitTab: TRACKER, totals: TOTALS, peTabs: [pe], now: NOW });
    expect(out.filter((f) => f.kind === "designed-no-permit")).toEqual([
      {
        kind: "designed-no-permit",
        detail: "PE-5: 2,000 ft designed, no permit listed in TOTALS",
        meta: "designed work with no permit path",
      },
    ]);
    const placed = out.filter((f) => f.kind === "placed-under-unapproved");
    expect(placed).toHaveLength(2);
    expect(placed[0]!.detail).toContain('placed under PERM-102 — status "In Review" — not approved');
    expect(placed[0]!.meta).toBe("agency: City of Springfield");
    expect(placed[1]!.detail).toContain("placed under PERM-999 — not in the Permit Tracker at all");
    const aging = out.filter((f) => f.kind === "submitted-aging");
    expect(aging).toHaveLength(2); // PERM-102 (submitted 6/1) and PERM-103 (5/20) — both 30d+
    expect(aging[0]!.detail).toContain("PERM-102 · City of Springfield — submitted");
    expect(aging[0]!.detail).toContain('still "In Review"');
    expect(aging[1]!.detail).toContain("still no status");
  });

  it("no-ops when the tracker is empty or the working tabs carry no permit column", () => {
    expect(permitFindings({ permitTab: snap(["Permit #", "Status"], [[]]), peTabs: [], now: NOW })).toEqual([]);
    const out = permitFindings({
      permitTab: TRACKER,
      peTabs: [{ title: "PE-4", data: snap(["Activity", "Start STA", "End STA", "Date Complete"], []) }],
      now: NOW,
    });
    expect(out.filter((f) => f.kind === "placed-under-unapproved")).toEqual([]);
  });

  it("no date column on the working tab means placed-ness can't be judged — stay silent", () => {
    const out = permitFindings({
      permitTab: TRACKER,
      peTabs: [{ title: "PE-4", data: snap(["Activity", "Permit Package"], [["Bore", "PERM-102"]]) }],
      now: NOW,
    });
    expect(out.filter((f) => f.kind === "placed-under-unapproved")).toEqual([]);
  });
});
