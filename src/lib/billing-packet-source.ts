import { and, desc, eq, ne } from "drizzle-orm";
import { buildBillingPacket, type BillingPacket } from "./billing";
import { db } from "./db";
import { snapshots, spreadsheets, tabs, type Spreadsheet } from "./db/schema";
import { detectStationColumns } from "./detect";
import { absoluteTime } from "./format";
import { computeGapReport } from "./gaps";
import { getPendingChanges } from "./pending";
import {
  agingGaps,
  dedupeTabData,
  detectLateEntries,
  detectOverplacement,
  invoiceStatus,
  officePipeline,
  type AgingGap,
  type LateEntry,
  type OfficePipeline,
  type OverplacementFinding,
} from "./production";
import { decodeSnapshot, latestNonImportSnapshots } from "./snapshots";

/**
 * The ONE assembly of the billing-day packet for a sheet — the CSV export,
 * the PDF export, and (via its own copy for per-section rendering) the
 * billing page all read this. Everything derives from the DATA clock (the
 * latest snapshot), so every artifact for the same data agrees and
 * re-exports are byte-identical.
 */
export async function assembleSheetBilling(
  id: string,
): Promise<
  { packet: BillingPacket; sheet: Spreadsheet; sinceFtKnown: boolean; dataAsOf: number } | { error: "no tracked tabs" }
> {
  const allSheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, id)).orderBy(tabs.position);
  const trackedTabs = allSheetTabs.filter((t) => t.tracked);
  if (trackedTabs.length === 0) return { error: "no tracked tabs" as const };
  const sheet = (await db.select().from(spreadsheets).where(eq(spreadsheets.id, id)).limit(1))[0]!;

  const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));

  let overplacement: OverplacementFinding[] = [];
  const totalsTab = allSheetTabs.find((t) => /totals?|summary/i.test(t.title));
  if (totalsTab) {
    const totalsSnap = (await latestNonImportSnapshots([totalsTab.id])).get(totalsTab.id);
    if (totalsSnap) overplacement = detectOverplacement(decodeSnapshot(totalsSnap.dataBlob));
  }

  const unresolvedRows: {
    tab: string;
    status: string;
    key: string | null;
    values: string[];
    cells: { header: string; from: string; to: string }[];
  }[] = [];
  const allAgedGaps: (AgingGap & { tab?: string })[] = [];
  const officeByTab: { tab: string; pipeline: OfficePipeline }[] = [];
  const invoicesByTab: { tab: string; status: ReturnType<typeof invoiceStatus> }[] = [];
  const allLateEntries: LateEntry[] = [];
  let totalSinceFt = 0;
  let anyBaselineFound = false;
  let anyStations = false;
  let latestLabel = "unknown";
  let latestAtMs = 0;

  const tabData: { title: string; data: ReturnType<typeof decodeSnapshot>; keyColumn?: number | null }[] = [];
  const dataByTitle = new Map<string, ReturnType<typeof decodeSnapshot>>();
  for (const tab of trackedTabs) {
    const latestSnap = latestByTab.get(tab.id);
    if (!latestSnap) continue;
    const data = decodeSnapshot(latestSnap.dataBlob);
    tabData.push({ title: tab.title, data, keyColumn: tab.keyColumn });
    dataByTitle.set(tab.title, data);
  }
  const dataAsOf = Math.max(0, ...trackedTabs.map((t) => latestByTab.get(t.id)?.createdAt ?? 0)) || Date.now();
  const { freshByTab, pureCopies, ownedRows } = dedupeTabData(tabData);
  for (const tab of trackedTabs) {
    const latestSnap = latestByTab.get(tab.id);
    if (!latestSnap) continue;
    if (latestSnap.createdAt > latestAtMs) {
      latestAtMs = latestSnap.createdAt;
      latestLabel = `${absoluteTime(latestSnap.createdAt)} · run ${latestSnap.runId.slice(0, 8)}`;
    }
    if (pureCopies.has(tab.title)) continue;
    const latestData = {
      headers: dataByTitle.get(tab.title)!.headers,
      rows: freshByTab.get(tab.title) ?? [],
    };
    if (detectStationColumns(latestData)) anyStations = true;
    const latestReport = computeGapReport(latestData);
    const ownedSlice = (blob: Buffer) => {
      const d = decodeSnapshot(blob);
      return { headers: d.headers, rows: ownedRows(new Map([[tab.title, d]])).get(tab.title) ?? [] };
    };

    const baselineRows = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tabId, tab.id), eq(snapshots.isBaseline, true), ne(snapshots.trigger, "import")))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    if (baselineRows[0]) {
      anyBaselineFound = true;
      const baselineReport = computeGapReport(ownedSlice(baselineRows[0].dataBlob));
      totalSinceFt += latestReport.placedFt - baselineReport.placedFt;
    }

    const window = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tabId, tab.id), ne(snapshots.trigger, "import")))
      .orderBy(desc(snapshots.createdAt))
      .limit(15);
    if (window.length > 0) {
      const walk = [...window].reverse().map((s) => ({
        createdAt: s.createdAt,
        data: s.id === latestSnap.id ? latestData : ownedSlice(s.dataBlob),
      }));
      for (const g of agingGaps(
        walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })),
        dataAsOf,
      )) {
        allAgedGaps.push({ ...g, tab: tab.title });
      }
      if (walk.length > 1) {
        for (const e of detectLateEntries(walk)) allLateEntries.push(e);
      }
    }

    officeByTab.push({ tab: tab.title, pipeline: officePipeline(latestData, dataAsOf) });
    invoicesByTab.push({ tab: tab.title, status: invoiceStatus(latestData, dataAsOf) });

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
    office: officeByTab,
    invoices: invoicesByTab,
    snapshotLabel: latestLabel,
    now: dataAsOf,
  });

  return { packet, sheet, sinceFtKnown: anyBaselineFound && anyStations, dataAsOf };
}
