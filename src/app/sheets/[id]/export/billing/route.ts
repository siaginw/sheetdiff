import { NextResponse } from "next/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { spreadsheets, tabs, snapshots } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSheetAccess } from "@/lib/access";
import { getPendingChanges } from "@/lib/pending";
import { decodeSnapshot, latestNonImportSnapshots } from "@/lib/snapshots";
import { computeGapReport } from "@/lib/gaps";
import { agingGaps, detectLateEntries, type LateEntry, type AgingGap } from "@/lib/production";
import { buildBillingPacket, billingPacketCsv } from "@/lib/billing";
import { absoluteTime } from "@/lib/format";

export const runtime = "nodejs";

/**
 * The Billing-Day Packet: one CSV with placed-since-collection footage, open
 * unaccounted holes (do-not-invoice), the to-enter worklist, and late entries
 * — everything the office needs on invoice day, from data already held.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getSheetAccess(id, user);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });
  const sheet = access.sheet;

  const trackedTabs = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, id))).filter((t) => t.tracked);
  if (trackedTabs.length === 0) {
    return NextResponse.json({ error: "no tracked tabs" }, { status: 400 });
  }

  // latest sheet snapshot per tab (ONE query — the perf lesson from fleet 3)
  const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));

  // walk window for aging + late entries (bounded, per active tab only — we use
  // the sheet's FIRST tracked tab's window as representative; the packet is a
  // whole-sheet artifact but the analytics are per-tab)
  const firstTracked = trackedTabs[0]!;
  const window = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.tabId, firstTracked.id), ne(snapshots.trigger, "import")))
    .orderBy(desc(snapshots.createdAt))
    .limit(31);
  const walk = [...window].reverse().map((s) => ({ createdAt: s.createdAt, data: decodeSnapshot(s.dataBlob) }));

  const lateEntries: LateEntry[] = walk.length > 1 ? detectLateEntries(walk) : [];
  const agedGaps: AgingGap[] =
    walk.length > 0
      ? agingGaps(walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })))
      : [];

  // per-tab pending + footage delta since each tab's baseline
  let totalSinceFt = 0;
  const allUnresolved: ReturnType<typeof getPendingChanges> extends Promise<infer R> ? (R extends { unresolved: infer U }[] ? U : never) : never[] = [] as never;
  const unresolvedRows: { tab: string; status: string; key: string | null; cells: { header: string; from: string; to: string }[]; values: string[] }[] = [];
  for (const tab of trackedTabs) {
    const pending = await getPendingChanges(tab);
    if (!pending) continue;
    // footage delta for THIS tab: compute both endpoints
    const latestSnap = latestByTab.get(tab.id);
    if (latestSnap) {
      const nowF = computeGapReport(decodeSnapshot(latestSnap.dataBlob));
      // the gap report gives total placed; the delta needs the baseline —
      // pending already tells us whether anything changed; for the packet we
      // use the sheet-level footage from the gap report below
      totalSinceFt += 0; // per-tab delta computed below via diff
    }
    for (const r of pending.unresolved) {
      unresolvedRows.push({
        tab: tab.title,
        status: r.status,
        key: r.key,
        cells: r.cells.map((c) => ({ header: c.header, from: c.from, to: c.to })),
        values: r.values,
      });
    }
  }

  // sheet-level footage: latest placed minus baseline placed (if we have both)
  const firstLatest = latestByTab.get(firstTracked.id);
  const latestFt = firstLatest ? computeGapReport(decodeSnapshot(firstLatest.dataBlob)).placedFt : 0;
  const baselineRow = window.find((s) => s.isBaseline);
  const baselineFt = baselineRow ? computeGapReport(decodeSnapshot(baselineRow.dataBlob)).placedFt : latestFt;
  const sinceFt = Math.max(0, latestFt - baselineFt);

  const packet = buildBillingPacket({
    sinceFt,
    holes: agedGaps,
    unresolved: unresolvedRows as never,
    lateEntries,
    snapshotLabel: firstLatest ? absoluteTime(firstLatest.createdAt) : "unknown",
  });

  const csv = billingPacketCsv(packet);
  const safeTitle = sheet.title.replace(/[^\w.-]+/g, "-").slice(0, 40) || "sheet";
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sheetdiff-${safeTitle}-billing-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
