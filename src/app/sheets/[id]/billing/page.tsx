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
  Printer,
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
import {
  agingGaps,
  detectLateEntries,
  detectOverplacement,
  officePipeline,
  invoiceStatus,
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

  const trackedTabs = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, id))).filter((t) => t.tracked);
  const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));

  let placedSinceFt = 0;
  let anyBaseline = false;
  let latestLabel = "unknown";
  let latestAtMs = 0;
  const allAgedGaps: (AgingGap & { tab?: string })[] = [];
  const allLate: LateEntry[] = [];
  const officeByTab: { tab: string; pipeline: OfficePipeline }[] = [];
  const invoicesByTab: { tab: string; status: InvoiceStatus }[] = [];
  const overplacements: OverplacementFinding[] = [];
  let toEnterCount = 0;

  for (const tab of trackedTabs) {
    const latestSnap = latestByTab.get(tab.id);
    if (!latestSnap) continue;
    if (latestSnap.createdAt > latestAtMs) {
      latestAtMs = latestSnap.createdAt;
      latestLabel = absoluteTime(latestSnap.createdAt);
    }
    const latestData = decodeSnapshot(latestSnap.dataBlob);
    const latestReport = computeGapReport(latestData);

    const baselineRows = await db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tabId, tab.id), eq(snapshots.isBaseline, true), ne(snapshots.trigger, "import")))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    if (baselineRows[0]) {
      anyBaseline = true;
      placedSinceFt += latestReport.placedFt - computeGapReport(decodeSnapshot(baselineRows[0].dataBlob)).placedFt;
    }

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
      if (walk.length > 1) for (const e of detectLateEntries(walk)) allLate.push(e);
    }

    officeByTab.push({ tab: tab.title, pipeline: officePipeline(latestData) });
    invoicesByTab.push({ tab: tab.title, status: invoiceStatus(latestData) });

    const pending = await getPendingChanges(tab);
    if (pending) toEnterCount += pending.counts.unresolved;
  }

  // over-placement from a TOTALS-like tab
  const totalsTab = trackedTabs.find((t) => /totals?|summary/i.test(t.title));
  if (totalsTab) {
    const totalsSnap = latestByTab.get(totalsTab.id);
    if (totalsSnap) overplacements.push(...detectOverplacement(decodeSnapshot(totalsSnap.dataBlob)));
  }

  const packet = buildBillingPacket({
    sinceFt: placedSinceFt,
    holes: allAgedGaps,
    unresolved: [],
    lateEntries: allLate,
    office: officeByTab,
    invoices: invoicesByTab,
    overplacement: overplacements,
    snapshotLabel: latestLabel,
  });

  // triage order: blockers first
  const blockers = packet.rows.filter((r) => r.kind === "hole" || r.kind === "over");
  const billable = packet.rows.filter((r) => r.detail.includes("BILLABLE"));
  const missedRuns = packet.rows.filter((r) => r.kind === "late" && r.detail.includes("invoice run"));
  const office = packet.rows.filter((r) => r.kind === "to-enter" && !r.detail.includes("BILLABLE") && r.meta?.includes("entered"));
  const late = packet.rows.filter((r) => r.kind === "late" && !r.detail.includes("invoice run"));
  const sinceFtKnown = anyBaseline;

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
              href={`${sheet.id}/export/billing`}
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
            billing day · snapshot {latestLabel} · {sinceFtKnown ? "" : "no collection point yet — footage since is unknown"}
          </p>
        </header>

        {/* headline numbers */}
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card label="placed since collection" value={sinceFtKnown ? ft(placedSinceFt) : "—"} icon={<Camera className="size-3.5" />} />
          <Card
            label="billable now"
            value={invoicesByTab.some((i) => i.status.billableNow.length > 0) ? `${invoicesByTab.reduce((n, i) => n + i.status.billableNow.length, 0)} rows` : "0"}
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

        {/* blockers first */}
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

        {late.length > 0 ? (
          <Section title="Late entries" tone="move" icon={<Clock className="size-4" />}>
            {late.slice(0, 10).map((r, i) => (
              <Row key={i} row={r} />
            ))}
            {late.length > 10 ? <More count={late.length - 10} /> : null}
          </Section>
        ) : null}

        {blockers.length + billable.length + missedRuns.length + office.length + late.length === 0 ? (
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
    <section className="mb-6">
      <h2 className={`mb-2 flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wide ${tone === "del" ? "text-diff-del-fg" : "text-diff-move-fg"}`}>
        {icon} {title}
      </h2>
      <ul className="space-y-1 font-mono text-[11.5px]">{children}</ul>
    </section>
  );
}

function Row({ row }: { row: BillingRow }) {
  return (
    <li className={`flex flex-wrap items-baseline gap-x-3 rounded border-l-2 py-1 pl-3 pr-2 ${row.kind === "hole" || row.kind === "over" ? "border-diff-del-fg bg-diff-del-bg/30" : "border-diff-move-fg bg-diff-move-bg/20"}`}>
      <span className="flex-1 min-w-0 break-words">{row.detail}</span>
      {row.ft !== undefined ? <span className="shrink-0 font-semibold">{ft(row.ft)}</span> : null}
      {row.meta ? <span className="shrink-0 text-[10px] text-muted-foreground">{row.meta}</span> : null}
    </li>
  );
}

function More({ count }: { count: number }) {
  return <li className="pl-3 text-[10.5px] text-muted-foreground">+{count} more…</li>;
}
