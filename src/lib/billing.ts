import type { SnapshotData, DiffRow } from "./diff/engine";
import { rowContentKey } from "./diff/engine";
import { norm } from "./diff/normalize";
import { detectActivityColumn } from "./detect";
import type { LateEntry, AgingGap } from "./production";

/**
 * The Billing-Day Packet: everything the office needs on invoice day, from
 * data the app already holds — placed footage since the last collection,
 * open unaccounted holes, unresolved changes (their to-enter worklist),
 * and late entries that landed after the last pull.
 */

export interface BillingRow {
  kind: "footage" | "hole" | "to-enter" | "late";
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
  holes: AgingGap[];
  unresolved: DiffRow[];
  lateEntries: LateEntry[];
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
  for (const h of input.holes) {
    rows.push({
      kind: "hole",
      detail: `Unaccounted ${Math.round(h.from).toLocaleString()}-${Math.round(h.to).toLocaleString()} (open ${h.daysOpen}d)`,
      ft: h.ft,
      meta: "do not invoice — unbooked footage",
    });
  }
  for (const r of input.unresolved.slice(0, 50)) {
    const what =
      r.status === "added"
        ? `NEW row: ${r.values.slice(0, 4).filter(Boolean).join(" | ")}`
        : r.status === "removed"
          ? `DELETED row: ${r.values.slice(0, 4).filter(Boolean).join(" | ")}`
          : r.cells.map((c) => `${c.header}: ${c.from} -> ${c.to}`).join("; ");
    rows.push({ kind: "to-enter", detail: what, meta: "enter in office system" });
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
export function billingPacketCsv(p: BillingPacket): string {
  const lines: string[] = [
    `# SheetDiff billing packet — generated ${new Date(p.generatedAt).toISOString()}`,
    `# Snapshot: ${p.snapshotLabel}`,
    `# Placed since collection: ${p.placedSinceFt.toLocaleString()} ft | Open holes: ${p.openHoleFt.toLocaleString()} ft | To enter: ${p.toEnterCount} | Late entries: ${p.lateCount}`,
    `Kind,Detail,Ft,Note`,
  ];
  for (const r of p.rows) {
    const esc = (v: string) => {
    // formula guard first (same rule as csvSafe — this CSV goes to Excel)
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /["\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
    lines.push([r.kind, esc(r.detail), r.ft !== undefined ? String(r.ft) : "", esc(r.meta ?? "")].join(","));
  }
  return lines.join("\n");
}

/**
 * Entry-latency leaderboard: median days from completion to first appearance,
 * per crew — team health, not outlier blame.
 */
export interface CrewLatency {
  crew: string;
  medianDays: number;
  entries: number;
  worstDays: number;
}

export function entryLatency(
  late: { activity: string; daysLate: number }[],
  data: SnapshotData,
  crewOf: (row: string[]) => string,
): CrewLatency[] {
  // aggregate detectLateEntries output by crew using the crew column
  const byCrew = new Map<string, number[]>();
  for (const e of late) {
    // find the row matching this late entry's activity to get its crew
    const row = data.rows.find((r) => norm(r[detectActivityColumn(data) ?? 0]) === e.activity);
    const crew = row ? crewOf(row) : "(unknown)";
    const list = byCrew.get(crew) ?? [];
    list.push(e.daysLate);
    byCrew.set(crew, list);
  }
  const out: CrewLatency[] = [];
  for (const [crew, days] of byCrew) {
    const sorted = [...days].sort((a, b) => a - b);
    out.push({
      crew,
      medianDays: sorted[Math.floor(sorted.length / 2)] ?? 0,
      entries: days.length,
      worstDays: sorted[sorted.length - 1] ?? 0,
    });
  }
  return out.sort((a, b) => b.medianDays - a.medianDays);
}

export interface VerifiedStaleRow {
  row: number;
  initials: string;
  verifiedOn: string;
  lastChangedAt: number;
}

/**
 * Verified-stale: rows whose "Verified by" initials predate the row's last
 * change — the initials are no longer a promise about the current values.
 */
export function verifiedStale(
  data: SnapshotData,
  rowChangedAt: Map<string, number>,
  now = Date.now(),
): VerifiedStaleRow[] {
  const verifiedCol = data.headers.findIndex((h) => /verified\s*by|checked\s*by|^qa$/i.test(norm(h)));
  if (verifiedCol < 0) return [];
  const out: VerifiedStaleRow[] = [];
  data.rows.forEach((row, i) => {
    const initials = norm(row[verifiedCol]);
    if (initials === "") return;
    const changedAt = rowChangedAt.get(rowContentKey(row));
    if (changedAt !== undefined && changedAt < now) {
      // a trace exists: if the row changed AFTER initials were applied it's stale.
      // Approximation: any recorded change event means verify-before-change risk
      out.push({ row: i + 1, initials, verifiedOn: "", lastChangedAt: changedAt });
    }
  });
  return out;
}

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
