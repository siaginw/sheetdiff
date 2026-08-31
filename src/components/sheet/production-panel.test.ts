/**
 * Component tests for the production panel's summary/body coherence — the
 * invoice chips rendered while the "clean" summary and the empty-state guard
 * ignored invoice findings entirely, and the body had no invoice section.
 * The panel is a server component (plain function returning elements), so
 * assertions walk the returned React element tree.
 */
import { describe, expect, it } from "vitest";
import { ProductionPanel } from "./production-panel";
import { invoiceStatus, type InvoiceStatus } from "@/lib/production";
import type { SnapshotData } from "@/lib/diff/engine";

function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out);
    return out;
  }
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    // walk every prop value, not just children — Section titles travel as props
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) for (const v of Object.values(props)) textOf(v, out);
  }
  return out;
}
const renderText = (el: unknown) => textOf(el).join(" ").replace(/\s+/g, " ");

const base = {
  tabTitle: "PE-4",
  hygiene: [],
  lateEntries: [],
  totalsMismatches: [],
  overplacements: [],
  crewBoard: null,
  agedGaps: [],
  office: null,
};

describe("ProductionPanel: invoice findings reach summary and body", () => {
  // a real ledger: one stuck billable (15d+), one aging (3-14d), a billed
  // invoice, a queued month run and a missed run — classified by the same
  // invoiceStatus() the sheet page feeds the panel
  const H = ["Activity", "Start STA", "End STA", "Date Complete", "Entered in InEight", "Invoice #", "Bore log in GIS"];
  const NOW = new Date("2026-08-30T12:00:00").getTime();
  const data: SnapshotData = {
    headers: H,
    rows: [
      ["Bore", "0", "2200", "2026-07-01", "", "", "Yes"], // 60d — stuck billable
      ["Plow", "2200", "2700", "2026-08-20", "", "", "Yes"], // 10d — aging billable
      ["Plow", "2700", "3200", "2026-08-01", "3118", "", "Yes"], // billed
      ["Plow", "3200", "3700", "2026-06-15", "July", "", "Yes"], // missed run
    ],
  };
  const invoices: InvoiceStatus = invoiceStatus(data, NOW);

  it("classifies the fixture as expected (stuck + aging + billed + missed)", () => {
    expect(invoices.billableNow.map((r) => r.daysSinceCompletion)).toEqual([60, 10]);
    expect(invoices.missedRun).toEqual([{ invoice: "July", rows: 1 }]);
    expect(invoices.billedByInvoice.find((x) => x.invoice === "3118")?.rows).toBe(1);
  });

  it("does NOT claim clean when invoice findings exist", () => {
    const text = renderText(ProductionPanel({ ...base, invoices }));
    expect(text).not.toContain("clean");
  });

  it("does NOT fall to the empty state when invoice findings are the only content", () => {
    const text = renderText(ProductionPanel({ ...base, invoices }));
    expect(text).not.toContain("No production analytics available");
  });

  it("renders the invoice ledger section: billable rows with ft, billed and missed-run lines", () => {
    const text = renderText(ProductionPanel({ ...base, invoices }));
    expect(text).toContain("Invoice ledger");
    expect(text).toContain("row 1 · Bore · 2,200 ft"); // stuck billable, ft shown
    expect(text).toContain("row 2 · Plow · 500 ft"); // aging billable
    expect(text).toContain("60 d unentered");
    expect(text).toContain("10 d unentered");
    expect(text).toContain("Invoice 3118 — 1 row");
    expect(text).toContain("July run already passed — 1 row never invoiced");
  });

  it("claims clean and shows the empty state when the ledger is genuinely empty", () => {
    const clean: InvoiceStatus = invoiceStatus(
      { headers: H, rows: [["Plow", "0", "500", "2026-08-28", "2026-08-29", "", "Yes"]] },
      NOW,
    );
    const text = renderText(ProductionPanel({ ...base, invoices: clean }));
    expect(text).toContain("clean");
    expect(text).toContain("No production analytics available");
  });
});
