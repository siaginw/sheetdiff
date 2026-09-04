import { PrintButton } from "@/components/sheet/print-button";
import { getSheetAccess } from "@/lib/access";
import { computeFootage } from "@/lib/checks";
import { db } from "@/lib/db";
import { tabs } from "@/lib/db/schema";
import type { SnapshotData } from "@/lib/diff/engine";
import { absoluteTime, relativeTime } from "@/lib/format";
import {
  aggregateWeekly,
  dedupeTabData,
  detectStoppageTab,
  isStoppageTabTitle,
  quietStoppageLog,
  stoppageWeeks,
  weeklyProduction,
  type QuietStoppageLog,
  type StoppageWeek,
  type WeekBucket,
} from "@/lib/production";
import { getSessionUser } from "@/lib/session";
import { decodeSnapshot, latestNonImportSnapshots } from "@/lib/snapshots";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

/**
 * The weekly one-pager: footage per week (as dated), placed-vs-designed
 * position, and the office backlog — the management-facing view Erin can
 * hand to a superintendent or attach to an update email. Print-ready.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/");
  const { id } = await params;
  const access = await getSheetAccess(id, user);
  if (!access) notFound();
  const sheet = access.sheet;

  const allTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, id)).orderBy(tabs.position);
  const trackedTabs = allTabs.filter((t) => t.tracked);
  const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));

  // aggregate weekly footage across every tracked tab that has stations+dates
  let latestAt: number | null = null;
  const perTab: { weeks: WeekBucket[]; placedFt: number }[] = [];
  // compilation tabs (Line List, PE-7 copies) copy the working tabs — count
  // each shot once via the shared cross-tab dedup helper (first tab wins),
  // never an inline reimplementation. A tab left with no fresh rows is a pure
  // copy: SKIP it — a bare `return` here used to blank the whole report the
  // moment any tracked tab duplicated another's rows.
  const tabData: { title: string; data: SnapshotData; keyColumn?: number | null }[] = [];
  for (const tab of trackedTabs) {
    const snap = latestByTab.get(tab.id);
    if (!snap) continue;
    const data = decodeSnapshot(snap.dataBlob);
    if (!computeFootage(data).stations) continue;
    latestAt = Math.max(latestAt ?? 0, snap.createdAt);
    tabData.push({ title: tab.title, data, keyColumn: tab.keyColumn });
  }
  const { freshByTab, pureCopies, duplicatesDropped } = dedupeTabData(tabData);
  const prodTabs: SnapshotData[] = []; // fresh (deduped) data — the quiet-log clock
  for (const { title, data } of tabData) {
    if (pureCopies.has(title)) continue; // pure compilation tab
    const fresh = freshByTab.get(title) ?? [];
    const freshData = { headers: data.headers, rows: fresh };
    prodTabs.push(freshData);
    perTab.push({
      weeks: weeklyProduction(freshData),
      // placed comes from the FRESH rows — computeFootage on the whole tab
      // would re-add every copy the dedup just dropped
      placedFt: computeFootage(freshData).ft,
    });
  }
  const { weeks, placedFt } = aggregateWeekly(perTab);

  // Work Stoppages: a dedicated log tab (tracked or not) explains quiet weeks
  // instead of implying nobody worked. Title match first (cheap — no blob
  // decode for unrelated tabs), then the header check via detectStoppageTab.
  let stoppages: Map<number, StoppageWeek> | null = null;
  let quietLog: QuietStoppageLog | null = null;
  const stoppageCandidates = allTabs.filter((t) => isStoppageTabTitle(t.title));
  if (stoppageCandidates.length > 0) {
    const snapsByTab = await latestNonImportSnapshots(stoppageCandidates.map((t) => t.id));
    const candData: { title: string; data: SnapshotData }[] = [];
    for (const t of stoppageCandidates) {
      const snap = snapsByTab.get(t.id);
      if (snap) candData.push({ title: t.title, data: decodeSnapshot(snap.dataBlob) });
    }
    const stoppageTab = detectStoppageTab(candData);
    if (stoppageTab) {
      stoppages = stoppageWeeks(stoppageTab.data);
      quietLog = quietStoppageLog(stoppages, prodTabs);
    }
  }
  const thisWeek = weeks[weeks.length - 1] ?? null;
  const lastWeek = weeks[weeks.length - 2] ?? null;
  const totalFt = weeks.reduce((n, w) => n + w.ft, 0);

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 print:py-0">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <Link
            href={`/sheets/${sheet.id}`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to {sheet.title}
          </Link>
          <PrintButton />
        </div>

        <header className="mb-8 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">{sheet.title}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            weekly production report · as of {latestAt ? absoluteTime(latestAt) : "no snapshots yet"}
            {latestAt ? ` (${relativeTime(latestAt)})` : ""} · footage as dated by crews
            {duplicatesDropped > 0
              ? ` · ${duplicatesDropped} copied row${duplicatesDropped === 1 ? "" : "s"} counted once`
              : ""}
          </p>
        </header>

        {weeks.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No dated footage yet — this report needs Date Complete and station columns on the tracked tabs.
          </p>
        ) : (
          <>
            {/* the headline numbers */}
            <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">placed total</div>
                <div className="mt-1 font-mono text-lg font-semibold">{placedFt.toLocaleString("en-US")} ft</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">this week</div>
                <div className="mt-1 font-mono text-lg font-semibold">
                  {thisWeek ? `${thisWeek.ft.toLocaleString("en-US")} ft` : "—"}
                </div>
                {thisWeek && lastWeek ? (
                  <div
                    className={`font-mono text-[10px] ${thisWeek.ft >= lastWeek.ft ? "text-diff-add-fg" : "text-diff-del-fg"}`}
                  >
                    {thisWeek.ft >= lastWeek.ft ? "+" : "−"}
                    {Math.abs(thisWeek.ft - lastWeek.ft).toLocaleString("en-US")} vs last week
                  </div>
                ) : null}
              </div>
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">weeks worked</div>
                <div className="mt-1 font-mono text-lg font-semibold">{weeks.length}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">dated footage</div>
                <div className="mt-1 font-mono text-lg font-semibold">{totalFt.toLocaleString("en-US")} ft</div>
              </div>
            </div>

            {/* the sparkline */}
            <section className="mb-8">
              <h2 className="mb-2 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                footage per week (as dated)
              </h2>
              <Sparkline weeks={weeks} />
            </section>

            {/* the table */}
            <section>
              <h2 className="mb-2 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                week by week
              </h2>
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-4 font-medium">week of</th>
                    <th className="py-1.5 pr-4 text-right font-medium">footage</th>
                    <th className="py-1.5 pr-4 text-right font-medium">shots</th>
                    {stoppages ? <th className="py-1.5 font-medium">stoppages</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {[...weeks].reverse().map((w) => {
                    const sw = stoppages?.get(w.weekStart) ?? null;
                    return (
                      <tr key={w.weekStart} className="border-b border-border/40">
                        <td className="py-1.5 pr-4">
                          {new Date(w.weekStart).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </td>
                        <td className="py-1.5 pr-4 text-right">{w.ft.toLocaleString("en-US")} ft</td>
                        <td className="py-1.5 pr-4 text-right">{w.shots}</td>
                        {stoppages ? (
                          <td className="max-w-[220px] py-1.5" title={sw?.exemplar ?? undefined}>
                            {sw ? (
                              <>
                                <span className="font-semibold">{`${sw.count} stoppage${sw.count === 1 ? "" : "s"}`}</span>
                                {sw.exemplar ? <span className="text-muted-foreground"> · {sw.exemplar}</span> : null}
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {quietLog ? (
                <p className="mt-3 rounded-lg border border-dashed px-3 py-2 text-[11px] text-warning">
                  Stoppage log looks quiet: newest entry {quietLog.newestStoppage} is {quietLog.daysBehind} day
                  {quietLog.daysBehind === 1 ? "" : "s"} behind the newest completed work ({quietLog.newestCompletion})
                  — is the log being kept?
                </p>
              ) : null}
              <p className="mt-3 text-[10.5px] text-muted-foreground">
                &ldquo;As dated&rdquo; = a row lands in the week its Date Complete says. Late-entered rows shift
                retroactively — check the production panel&rsquo;s late entries before quoting a quiet week.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Sparkline({ weeks }: { weeks: WeekBucket[] }) {
  const w = 640;
  const h = 120;
  const pad = 6;
  const max = Math.max(...weeks.map((x) => x.ft), 1);
  const barW = Math.max(2, Math.floor((w - pad * 2) / weeks.length) - 3);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="footage per week bar chart">
      {weeks.map((x, i) => {
        const barH = Math.round(((h - pad * 2) * x.ft) / max);
        const bx = pad + i * ((w - pad * 2) / weeks.length);
        return (
          <rect
            key={x.weekStart}
            x={bx}
            y={h - pad - barH}
            width={barW}
            height={Math.max(barH, 1)}
            rx={1.5}
            className="fill-primary"
            opacity={i === weeks.length - 1 ? 1 : 0.55}
          >
            <title>{`${new Date(x.weekStart).toLocaleDateString("en-US")} — ${x.ft.toLocaleString("en-US")} ft`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
