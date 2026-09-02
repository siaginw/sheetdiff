import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Camera,
  Clock,
  Download,
  ReceiptText,
  Timer,
} from "lucide-react";
import { db } from "@/lib/db";
import { tabs, snapshots } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSheetAccess } from "@/lib/access";
import { getPendingChanges } from "@/lib/pending";
import { decodeSnapshot, latestNonImportSnapshots } from "@/lib/snapshots";
import { computeGapReport } from "@/lib/gaps";
import { detectStationColumns } from "@/lib/detect";
import {
  agingGaps,
  detectLateEntries,
  detectOverplacement,
  officePipeline,
  invoiceStatus,
  dedupeTabData,
  type AgingGap,
  type LateEntry,
  type OverplacementFinding,
  type OfficePipeline,
  type InvoiceStatus,
} from "@/lib/production";
import { buildBillingPacket, type BillingRow } from "@/lib/billing";
import { absoluteTime } from "@/lib/format";
import { PrintButton } from "@/components/sheet/print-button";

const ft = (n: number) => n.toLocaleString("en-US");

export default async function BillingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/");
  const { id } = await params;
  const access = await getSheetAccess(id, user);
  if (!access) notFound();
  const sheet = access.sheet;

  const trackedTabs = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, id)).orderBy(tabs.position)).filter((t) => t.tracked);
  const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));

  let placedSinceFt = 0;
  let anyBaseline = false;
  let anyStations = false; // footage math exists at all (station columns)
  let latestLabel = "unknown";
  let latestAtMs = 0;
  const allAgedGaps: (AgingGap & { tab?: string })[] = [];
  const allLate: LateEntry[] = [];
  const officeByTab: { tab: string; pipeline: OfficePipeline }[] = [];
  const invoicesByTab: { tab: string; status: InvoiceStatus }[] = [];
  const overplacements: OverplacementFinding[] = [];
  let toEnterCount = 0;
  const pendingRows: { status: string; values: string[]; cells: { header: string; from: string; to: string }[]; tab?: string }[] = [];

  // compilation tabs (Line List copies working tabs) would double-count every
  // hole, billable row, and office backlog entry on the money page — the
  // shared cross-tab dedup (same algorithm as the CSV export and the weekly
  // report) keys each row once; a pure copy tab contributes nothing
  const tabData: { title: string; data: ReturnType<typeof decodeSnapshot>; keyColumn?: number | null }[] = [];
  const dataByTitle = new Map<string, ReturnType<typeof decodeSnapshot>>();
  for (const tab of trackedTabs) {
    const latestSnap = latestByTab.get(tab.id);
    if (!latestSnap) continue;
    const data = decodeSnapshot(latestSnap.dataBlob);
    tabData.push({ title: tab.title, data, keyColumn: tab.keyColumn });
    dataByTitle.set(tab.title, data);
  }
  // the DATA clock — the same one the CSV export uses: ages, stamps, and the
  // packet all read the latest snapshot time, never the render moment, so the
  // screen and the file can never disagree and re-renders are deterministic
  // (Date.now is impure during render per the React Compiler; this is a
  // server component where it's safe — same suppression the sheet page uses)
  // eslint-disable-next-line react-hooks/purity
  const fallbackNow = Date.now();
  const dataAsOf = Math.max(
    0,
    ...trackedTabs.map((t) => latestByTab.get(t.id)?.createdAt ?? 0),
  ) || fallbackNow;
  const { freshByTab, pureCopies, ownedRows } = dedupeTabData(tabData);
  for (const tab of trackedTabs) {
    const latestSnap = latestByTab.get(tab.id);
    if (!latestSnap) continue;
    if (latestSnap.createdAt > latestAtMs) {
      latestAtMs = latestSnap.createdAt;
      // run id beside the time: if the office disputes a number, the packet
      // names the exact capture it came from (audit trail)
      latestLabel = `${absoluteTime(latestSnap.createdAt)} · run ${latestSnap.runId.slice(0, 8)}`;
    }
    if (pureCopies.has(tab.title)) continue;
    const freshData = {
      headers: dataByTitle.get(tab.title)!.headers,
      rows: freshByTab.get(tab.title) ?? [],
    };
    if (detectStationColumns(freshData)) anyStations = true;
    const latestReport = computeGapReport(freshData);
    // any non-latest snapshot of this tab is filtered to the rows THIS tab
    // owns (ownership decided on latest data) — a compilation tab's copied
    // rows must not appear in its baseline either, or the delta goes negative
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
      anyBaseline = true;
      placedSinceFt += latestReport.placedFt - computeGapReport(ownedSlice(baselineRows[0].dataBlob)).placedFt;
    }

    const windowSnaps = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tabId, tab.id), ne(snapshots.trigger, "import")))
      .orderBy(desc(snapshots.createdAt))
      .limit(15);
    if (windowSnaps.length > 0) {
      const walk = [...windowSnaps].reverse().map((s) => ({
        createdAt: s.createdAt,
        data: s.id === latestSnap.id ? freshData : ownedSlice(s.dataBlob),
      }));
      for (const g of agingGaps(walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })), dataAsOf)) {
        allAgedGaps.push({ ...g, tab: tab.title });
      }
      if (walk.length > 1) for (const e of detectLateEntries(walk)) allLate.push(e);
    }

    officeByTab.push({ tab: tab.title, pipeline: officePipeline(freshData, dataAsOf) });
    invoicesByTab.push({ tab: tab.title, status: invoiceStatus(freshData, dataAsOf) });

    const pending = await getPendingChanges(tab);
    if (pending) {
      toEnterCount += pending.counts.unresolved;
      for (const r of pending.unresolved) {
        pendingRows.push({ status: r.status, values: r.values, cells: r.cells.map((c) => ({ header: c.header, from: c.from, to: c.to })), tab: tab.title });
      }
    }
  }

  const allTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, id));
  const totalsTab = allTabs.find((t) => /totals?|summary/i.test(t.title));
  if (totalsTab) {
    const totalsSnap = latestByTab.get(totalsTab.id);
    if (totalsSnap) overplacements.push(...detectOverplacement(decodeSnapshot(totalsSnap.dataBlob)));
  }

  const packet = buildBillingPacket({
    sinceFt: placedSinceFt,
    holes: allAgedGaps,
    unresolved: pendingRows,
    lateEntries: allLate,
    office: officeByTab,
    invoices: invoicesByTab,
    overplacement: overplacements,
    snapshotLabel: latestLabel,
    now: dataAsOf,
  });

  // classify by KIND + meta prefix, never by detail-substring (sheet-controlled
  // activity text containing "BILLABLE" would misclassify)
  const blockers = packet.rows.filter((r) => r.kind === "hole" || r.kind === "over");
  const billable = packet.rows.filter((r) => r.kind === "to-enter" && r.meta?.startsWith("invoice when entered"));
  const missedRuns = packet.rows.filter((r) => r.kind === "late" && r.meta?.startsWith("chase the office"));
  const office = packet.rows.filter((r) => r.kind === "to-enter" && r.meta?.startsWith("per the sheet"));
  const late = packet.rows.filter((r) => r.kind === "late" && !r.meta?.startsWith("chase the office"));
  const toEnterList = packet.rows.filter(
    (r) => r.kind === "to-enter" && !r.meta?.startsWith("invoice when entered") && !r.meta?.startsWith("per the sheet"),
  );
  // footage-since is only knowable when BOTH a collection point exists AND
  // the sheet carries station columns — a generic sheet (no stations) must
  // say so instead of confidently reporting "0 ft"
  const sinceFtKnown = anyBaseline && anyStations;
  const billableCount = invoicesByTab.reduce((n, i) => n + i.status.billableNow.length, 0);

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto max-w-4xl px-4 py-8 print:py-0">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <Link
            href={`/sheets/${sheet.id}`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to {sheet.title}
          </Link>
          <div className="flex items-center gap-2">
            <a
              href={`/sheets/${sheet.id}/export/billing`}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
            >
              <Download className="size-4" /> CSV
            </a>
            <PrintButton />
          </div>
        </div>

        <header className="mb-8 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">{sheet.title}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            billing day · snapshot {latestLabel}
            {sinceFtKnown
              ? ""
              : !anyStations
                ? " · no station columns — this sheet tracks rows, not footage; the to-enter counts below are the numbers that matter"
                : " · no collection point yet — footage since is unknown"}
          </p>
        </header>

        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card
            label="placed since collection"
            value={sinceFtKnown ? `${ft(placedSinceFt)} ft` : "—"}
            sub={
              sinceFtKnown && placedSinceFt < 0
                ? "negative = corrections/removals since the last collection"
                : !anyStations
                  ? "row-based sheet — footage math is station sheets only"
                  : undefined
            }
            icon={<Camera className="size-3.5" />}
          />
          <Card
            label="billable now"
            value={billableCount === 0 ? "0" : `${billableCount} row${billableCount === 1 ? "" : "s"}`}
            sub={invoicesByTab.some((i) => i.status.oldestAgeDays) ? `oldest ${Math.max(...invoicesByTab.map((i) => i.status.oldestAgeDays ?? 0))}d` : undefined}
            icon={<ReceiptText className="size-3.5" />}
          />
          <Card
            label="open holes"
            value={ft(allAgedGaps.reduce((n, g) => n + g.ft, 0))}
            sub={`${allAgedGaps.length} hole${allAgedGaps.length === 1 ? "" : "s"}`}
            icon={<AlertTriangle className="size-3.5" />}
          />
          <Card label="to enter" value={String(toEnterCount)} icon={<Timer className="size-3.5" />} />
        </div>

        {blockers.length > 0 ? (
          <Section title="Do not invoice" tone="del" icon={<Ban className="size-4" />}>
            {blockers.map((r, i) => (
              <Row key={i} row={r} />
            ))}
          </Section>
        ) : null}

        {billable.length > 0 ? (
          <Section title="Billable — complete, in GIS, never entered" tone="move" icon={<ReceiptText className="size-4" />}>
            {billable.slice(0, 20).map((r, i) => (
              <Row key={i} row={r} />
            ))}
            {billable.length > 20 ? <More count={billable.length - 20} /> : null}
          </Section>
        ) : null}

        {missedRuns.length > 0 ? (
          <Section title="Missed invoice runs — chase the office" tone="del" icon={<Clock className="size-4" />}>
            {missedRuns.map((r, i) => (
              <Row key={i} row={r} />
            ))}
          </Section>
        ) : null}

        {office.length > 0 ? (
          <Section title="Waiting on office entry" tone="move" icon={<Clock className="size-4" />}>
            {office.slice(0, 15).map((r, i) => (
              <Row key={i} row={r} />
            ))}
            {office.length > 15 ? <More count={office.length - 15} /> : null}
          </Section>
        ) : null}

        {toEnterList.length > 0 ? (
          <Section title="Still to enter in the office system" tone="move" icon={<Timer className="size-4" />}>
            {toEnterList.slice(0, 15).map((r, i) => (
              <Row key={i} row={r} />
            ))}
            {toEnterList.length > 15 ? <More count={toEnterList.length - 15} /> : null}
          </Section>
        ) : null}

        {late.length > 0 ? (
          <Section title="Late entries" tone="move" icon={<Clock className="size-4" />}>
            {late.slice(0, 10).map((r, i) => (
              <Row key={i} row={r} />
            ))}
            {late.length > 10 ? <More count={late.length - 10} /> : null}
          </Section>
        ) : null}

        {blockers.length + billable.length + missedRuns.length + office.length + toEnterList.length + late.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing to chase — no blockers, no backlog, no late entries.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Card({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
      {sub ? <div className="font-mono text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function Section({ title, tone, icon, children }: { title: string; tone: "del" | "move"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6 print:break-inside-avoid-page">
      <h2 className={`mb-2 flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wide ${tone === "del" ? "text-diff-del-fg" : "text-diff-move-fg"}`}>
        {icon} {title}
      </h2>
      <ul className="space-y-1 font-mono text-[11.5px]">{children}</ul>
    </section>
  );
}

function Row({ row }: { row: BillingRow }) {
  return (
    <li className={`flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded border-l-2 py-1 pl-3 pr-2 print:break-inside-avoid ${row.kind === "hole" || row.kind === "over" ? "border-diff-del-fg bg-diff-del-bg/30" : "border-diff-move-fg bg-diff-move-bg/20"}`}>
      <span className="min-w-0 flex-1 break-words">{row.detail}</span>
      {row.ft !== undefined ? <span className="shrink-0 font-semibold">{ft(row.ft)}</span> : null}
      {row.meta ? <span className="min-w-0 shrink text-[10px] break-words text-muted-foreground">{row.meta}</span> : null}
    </li>
  );
}

function More({ count }: { count: number }) {
  return <li className="pl-3 text-[10.5px] text-muted-foreground">+{count} more…</li>;
}
