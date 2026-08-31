import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft, Printer } from "lucide-react";
import { db } from "@/lib/db";
import { tabs } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSheetAccess } from "@/lib/access";
import { latestNonImportSnapshots, decodeSnapshot } from "@/lib/snapshots";
import { weeklyProduction, type WeekBucket } from "@/lib/production";
import { computeFootage } from "@/lib/checks";
import { absoluteTime, relativeTime } from "@/lib/format";
import { PrintButton } from "@/components/sheet/print-button";

/**
 * The weekly one-pager: footage per week (as dated), placed-vs-designed
 * position, and the office backlog — the management-facing view Erin can
 * hand to a superintendent or attach to an update email. Print-ready.
 */
export default async function ReportPage({
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

  // aggregate weekly footage across every tracked tab that has stations+dates
  const byWeek = new Map<number, WeekBucket>();
  let placedFt = 0;
  let latestAt: number | null = null;
  for (const tab of trackedTabs) {
    const snap = latestByTab.get(tab.id);
    if (!snap) continue;
    const data = decodeSnapshot(snap.dataBlob);
    const f = computeFootage(data);
    if (!f.stations) continue;
    placedFt += f.ft;
    latestAt = Math.max(latestAt ?? 0, snap.createdAt);
    for (const w of weeklyProduction(data)) {
      const bucket = byWeek.get(w.weekStart) ?? { weekStart: w.weekStart, ft: 0, shots: 0 };
      bucket.ft += w.ft;
      bucket.shots += w.shots;
      byWeek.set(w.weekStart, bucket);
    }
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.weekStart - b.weekStart);
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
          </p>
        </header>

        {weeks.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No dated footage yet — this report needs Date Complete and station columns on the
            tracked tabs.
          </p>
        ) : (
          <>
            {/* the headline numbers */}
            <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">placed total</div>
                <div className="mt-1 font-mono text-lg font-semibold">{placedFt.toLocaleString("en-US")} ft</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">this week</div>
                <div className="mt-1 font-mono text-lg font-semibold">
                  {thisWeek ? `${thisWeek.ft.toLocaleString("en-US")} ft` : "—"}
                </div>
                {thisWeek && lastWeek ? (
                  <div className={`font-mono text-[10px] ${thisWeek.ft >= lastWeek.ft ? "text-diff-add-fg" : "text-diff-del-fg"}`}>
                    {thisWeek.ft >= lastWeek.ft ? "+" : "−"}
                    {Math.abs(thisWeek.ft - lastWeek.ft).toLocaleString("en-US")} vs last week
                  </div>
                ) : null}
              </div>
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">weeks worked</div>
                <div className="mt-1 font-mono text-lg font-semibold">{weeks.length}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">dated footage</div>
                <div className="mt-1 font-mono text-lg font-semibold">{totalFt.toLocaleString("en-US")} ft</div>
              </div>
            </div>

            {/* the sparkline */}
            <section className="mb-8">
              <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                footage per week (as dated)
              </h2>
              <Sparkline weeks={weeks} />
            </section>

            {/* the table */}
            <section>
              <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                week by week
              </h2>
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-4 font-medium">week of</th>
                    <th className="py-1.5 pr-4 text-right font-medium">footage</th>
                    <th className="py-1.5 text-right font-medium">shots</th>
                  </tr>
                </thead>
                <tbody>
                  {[...weeks].reverse().map((w) => (
                    <tr key={w.weekStart} className="border-b border-border/40">
                      <td className="py-1.5 pr-4">{new Date(w.weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td className="py-1.5 pr-4 text-right">{w.ft.toLocaleString("en-US")} ft</td>
                      <td className="py-1.5 text-right">{w.shots}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[10.5px] text-muted-foreground">
                &ldquo;As dated&rdquo; = a row lands in the week its Date Complete says. Late-entered
                rows shift retroactively — check the production panel&rsquo;s late entries before
                quoting a quiet week.
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
