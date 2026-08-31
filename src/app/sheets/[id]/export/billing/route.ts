import { NextResponse } from "next/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabs, snapshots } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSheetAccess } from "@/lib/access";
import { getPendingChanges } from "@/lib/pending";
import { decodeSnapshot, latestNonImportSnapshots } from "@/lib/snapshots";
import { computeGapReport } from "@/lib/gaps";
import { agingGaps, detectLateEntries, detectOverplacement, officePipeline, type LateEntry, type AgingGap, type OverplacementFinding, type OfficePipeline } from "@/lib/production";
import { buildBillingPacket, billingPacketCsv } from "@/lib/billing";
import { absoluteTime } from "@/lib/format";

export const runtime = "nodejs";

/**
 * The Billing-Day Packet: one CSV with placed-since-collection footage, open
 * unaccounted holes (do-not-invoice), the to-enter worklist, and late entries.
 * Aggregates EVERY tracked tab — a whole-sheet artifact, never tab 0's numbers.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getSheetAccess(id, user);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });
  const sheet = access.sheet;

  const allSheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, id));
  const trackedTabs = allSheetTabs.filter((t) => t.tracked);
  if (trackedTabs.length === 0) {
    return NextResponse.json({ error: "no tracked tabs" }, { status: 400 });
  }

  // ONE query for latest non-import snapshots of ALL tracked tabs
  const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));

  // over-placement guard: TOTALS rows claiming more placed than designed are
  // do-not-invoice bait — same totals-like tab the sheet page reconciles against
  let overplacement: OverplacementFinding[] = [];
  const totalsTab = allSheetTabs.find((t) => /totals?|summary/i.test(t.title));
  if (totalsTab) {
    const totalsSnap = (await latestNonImportSnapshots([totalsTab.id])).get(totalsTab.id);
    if (totalsSnap) overplacement = detectOverplacement(decodeSnapshot(totalsSnap.dataBlob));
  }

  // aggregate across EVERY tracked tab
  const unresolvedRows: { tab: string; status: string; key: string | null; values: string[]; cells: { header: string; from: string; to: string }[] }[] = [];
  const allAgedGaps: (AgingGap & { tab?: string })[] = [];
  const officeByTab: { tab: string; pipeline: OfficePipeline }[] = [];
  const allLateEntries: LateEntry[] = [];
  let totalSinceFt = 0;
  let anyBaselineFound = false;
  let latestLabel = "unknown";

  for (const tab of trackedTabs) {
    const latestSnap = latestByTab.get(tab.id);
    if (!latestSnap) continue;
    const latestReport = computeGapReport(decodeSnapshot(latestSnap.dataBlob));
    latestLabel = absoluteTime(latestSnap.createdAt);

    // this tab's baseline (query per tab — bounded, billing-export only)
    const baselineRows = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tabId, tab.id), eq(snapshots.isBaseline, true), ne(snapshots.trigger, "import")))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);

    if (baselineRows[0]) {
      anyBaselineFound = true;
      const baselineReport = computeGapReport(decodeSnapshot(baselineRows[0].dataBlob));
      // negative deltas are REAL (footage corrected/removed) — report, don't clamp
      totalSinceFt += latestReport.placedFt - baselineReport.placedFt;
    }

    // holes + late entries from a bounded window (cheap enough for billing day)
    const window = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tabId, tab.id), ne(snapshots.trigger, "import")))
      .orderBy(desc(snapshots.createdAt))
      .limit(15);
      if (window.length > 0) {
        const walk = [...window].reverse().map((s) => ({ createdAt: s.createdAt, data: decodeSnapshot(s.dataBlob) }));
        for (const g of agingGaps(walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })))) {
          allAgedGaps.push({ ...g, tab: tab.title });
        }
        if (walk.length > 1) {
          for (const e of detectLateEntries(walk)) allLateEntries.push(e);
        }
      }

    // the office-entry backlog comes from the sheet's own entered-column
    officeByTab.push({ tab: tab.title, pipeline: officePipeline(decodeSnapshot(latestSnap.dataBlob)) });

    const pending = await getPendingChanges(tab);
    if (pending) {
      for (const r of pending.unresolved) {
        unresolvedRows.push({
          tab: tab.title,
          status: r.status,
          key: r.key,
          values: r.values,
          cells: r.cells,
        });
      }
    }
  }

  const packet = buildBillingPacket({
    sinceFt: anyBaselineFound ? totalSinceFt : 0,
    holes: allAgedGaps,
    unresolved: unresolvedRows,
    lateEntries: allLateEntries,
    overplacement,
    snapshotLabel: latestLabel,
  });

  // when the number is unknowable (no tab had a baseline), say so — never a confident 0
  const csv = billingPacketCsv(packet, { sinceFtKnown: anyBaselineFound });

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
