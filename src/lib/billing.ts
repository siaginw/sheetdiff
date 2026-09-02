import type { LateEntry, AgingGap, OverplacementFinding, OfficePipeline, InvoiceStatus } from "./production";
import { csvSafe } from "./csv";
/** What buildBillingPacket actually reads — any richer type (like DiffRow[])
 *  satisfies this structurally, so callers pass pending.unresolved directly. */
export interface BillingUnresolvedRow {
  status: string;
  values: string[];
  cells: { header: string; from: string; to: string }[];
}

/**
 * The Billing-Day Packet: everything the office needs on invoice day, from
 * data the app already holds — placed footage since the last collection,
 * open unaccounted holes, unresolved changes (their to-enter worklist),
 * late entries that landed after the last pull, and packages TOTALS claims
 * are placed beyond their designed footage.
 */

export interface BillingRow {
  kind: "footage" | "hole" | "to-enter" | "late" | "over";
  detail: string;
  ft?: number;
  meta?: string;
}

export interface BillingPacket {
  rows: BillingRow[];
  placedSinceFt: number;
  openHoleFt: number;
  toEnterCount: number;
  lateCount: number;
  generatedAt: number;
  snapshotLabel: string;
}

export function buildBillingPacket(input: {
  sinceFt: number;
  holes: (AgingGap & { tab?: string })[];
  unresolved: BillingUnresolvedRow[];
  lateEntries: LateEntry[];
  /** TOTALS packages where Placed exceeds Designed — do-not-invoice bait */
  overplacement?: OverplacementFinding[];
  /** per-tab office-entry backlog from the sheets' own "entered" columns */
  office?: { tab: string; pipeline: OfficePipeline }[];
  /** per-tab invoice ledger rollup (billable-now aging, missed runs) */
  invoices?: { tab: string; status: InvoiceStatus }[];
  snapshotLabel: string;
  now?: number;
}): BillingPacket {
  const now = input.now ?? Date.now();
  const rows: BillingRow[] = [];
  rows.push({
    kind: "footage",
    detail: `Placed footage since last collection`,
    ft: input.sinceFt,
  });
  for (const o of input.overplacement ?? []) {
    rows.push({
      kind: "over",
      detail: `${o.tabTitle}: placed ${o.placed.toLocaleString("en-US")} ft vs ${o.designed.toLocaleString("en-US")} ft designed`,
      ft: o.overBy,
      meta: "do not invoice the excess — TOTALS claims more placed than designed",
    });
  }
  for (const h of input.holes) {
    rows.push({
      kind: "hole",
      detail: `Unaccounted ${Math.round(h.from).toLocaleString("en-US")}-${Math.round(h.to).toLocaleString("en-US")} (open ${h.daysOpen}d)`,
      ft: h.ft,
      // with 3+ tracked spreads the office must know WHICH tab a hole is on
      meta: `do not invoice — unbooked footage${h.tab ? ` (${h.tab})` : ""}`,
    });
  }
  for (const r of input.unresolved.slice(0, 50)) {
    const what =
      r.status === "added"
        ? `NEW row: ${r.values.slice(0, 4).filter(Boolean).join(" | ")}`
        : r.status === "removed"
          ? `DELETED row: ${r.values.slice(0, 4).filter(Boolean).join(" | ")}`
          : r.cells.map((c) => `${c.header}: ${c.from} -> ${c.to}`).join("; ");
    rows.push({ kind: "to-enter", detail: what, meta: `enter in office system${(r as { tab?: string }).tab ? ` (${(r as { tab?: string }).tab})` : ""}` });
  }
  for (const o of input.invoices ?? []) {
    // the A/R backlog: completed, GIS-checked, never entered — aged by
    // completion date; the oldest rows are the billing-day conversation
    for (const row of o.status.billableNow.slice(0, 20)) {
      rows.push({
        kind: "to-enter",
        detail: `Row ${row.row} (${row.activity}) completed ${row.completedOn} — BILLABLE ${row.daysSinceCompletion}d unentered (${row.ft.toLocaleString("en-US")} ft)`,
        meta: `invoice when entered (${o.tab})`,
      });
    }
    for (const m of o.status.missedRun) {
      rows.push({
        kind: "late",
        detail: `${m.rows} row${m.rows === 1 ? "" : "s"} marked for the "${m.invoice}" invoice run — that run already happened`,
        meta: `chase the office (${o.tab})`,
      });
    }
  }
  for (const o of input.office ?? []) {
    // the sheet's own record of completed-but-unentered work — stuck rows
    // are billing-day blockers the ack layer cannot see
    for (const r of [...o.pipeline.stuck, ...o.pipeline.aging].slice(0, 20)) {
      rows.push({
        kind: "to-enter",
        detail: `Row ${r.row} (${r.activity}) completed ${r.completedOn} — ${r.daysWaiting} days not entered in the office system`,
        meta: `per the sheet's "${o.pipeline.enteredColumn}" column (${o.tab})`,
      });
    }
  }
  for (const e of input.lateEntries.slice(0, 20)) {
    rows.push({
      kind: "late",
      detail: `Row ${e.row} (${e.activity}) dated ${e.completedOn}, entered ${e.daysLate}d late`,
      meta: "verify office system has it",
    });
  }
  return {
    rows,
    placedSinceFt: input.sinceFt,
    openHoleFt: input.holes.reduce((n, h) => n + h.ft, 0),
    toEnterCount: input.unresolved.length,
    lateCount: input.lateEntries.length,
    generatedAt: now,
    snapshotLabel: input.snapshotLabel,
  };
}

/** CSV export of the billing packet, stamped with its snapshot provenance. */
export function billingPacketCsv(p: BillingPacket, opts?: { sinceFtKnown?: boolean }): string {
  const lines: string[] = [
    `# SheetDiff billing packet — data as of ${new Date(p.generatedAt).toISOString()} (byte-identical on re-export)`,
    `# Snapshot: ${p.snapshotLabel}`,
    `# Placed since collection: ${opts?.sinceFtKnown === false ? "COULD NOT DETERMINE — no collection marker or no station columns (row-based sheet)" : p.placedSinceFt.toLocaleString("en-US") + " ft"} | Open holes: ${p.openHoleFt.toLocaleString("en-US")} ft | To enter: ${p.toEnterCount} | Late entries: ${p.lateCount}`,
    `Kind,Detail,Ft,Note`,
  ];
  for (const r of p.rows) {
    const esc = (v: string) => {
      // formula guard first (same rule as csvSafe — this CSV goes to Excel,
      // pure numbers exempt so a -65 ft correction round-trips), then quote
      // on comma/quote/newline/CR — an unquoted comma SPLITS the field and
      // the unguarded remainder lands in another cell (fleet-7 HIGH)
      const safe = csvSafe(v);
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const KIND_LABELS: Record<BillingRow["kind"], string> = {
    footage: "FOOTAGE",
    hole: "DO NOT INVOICE",
    "to-enter": "TO ENTER",
    late: "LATE ENTRY",
    over: "OVER-PLACED",
  };
    lines.push([KIND_LABELS[r.kind] ?? r.kind, esc(r.detail), r.ft !== undefined ? String(r.ft) : "", esc(r.meta ?? "")].join(","));
  }
  return lines.join("\n");
}

/**
 * Entry-latency leaderboard: median days from completion to first appearance,
 * per crew — team health, not outlier blame.
 */
/** Quiet-tab: days since a tab last saw a new row (staleness alarm). */
export function quietTabs(
  tabs: { title: string; lastNewRowAt: number | null }[],
  now = Date.now(),
  thresholdDays = 5,
): { title: string; days: number }[] {
  return tabs
    .filter((t) => t.lastNewRowAt !== null)
    .map((t) => ({ title: t.title, days: Math.floor((now - t.lastNewRowAt!) / 86_400_000) }))
    .filter((t) => t.days >= thresholdDays)
    .sort((a, b) => b.days - a.days);
}
