import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import {
  ArrowLeft,
  ArrowUpRight,
  Camera,
  CheckCircle2,
  Clock,
  ExternalLink,
  MoreHorizontal,
  Star,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DiffView } from "@/components/diff/diff-view";
import { SnapshotSelect } from "@/components/sheet/snapshot-select";
import { ScheduleDialog } from "@/components/sheet/schedule-dialog";
import { TabSettingsDialog } from "@/components/sheet/tab-settings-dialog";
import { DeleteSheetDialog } from "@/components/sheet/delete-dialog";
import { db } from "@/lib/db";
import { spreadsheets, tabs, snapshots } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getTabDiff, decodeSnapshot } from "@/lib/snapshots";
import { diffSnapshots, detectKeyColumn } from "@/lib/diff/engine";
import { absoluteTime, relativeTime, scheduleLabel } from "@/lib/format";
import { snapshotNow, setBaseline } from "@/lib/actions";

const TIMELINE_STATS_LIMIT = 30;

export default async function SheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/");

  const { id } = await params;
  const sp = await searchParams;

  const sheetRows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, id));
  const sheet = sheetRows[0];
  if (!sheet || sheet.userId !== user.id) notFound();

  const allTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id)).orderBy(tabs.position);
  if (allTabs.length === 0) notFound();

  const tabParam = typeof sp.tab === "string" ? sp.tab : null;
  const activeTab = allTabs.find((t) => t.title === tabParam) ?? allTabs.find((t) => t.tracked) ?? allTabs[0];

  // timeline rows (no blobs)
  const timeline = await db
    .select({
      id: snapshots.id,
      runId: snapshots.runId,
      trigger: snapshots.trigger,
      isBaseline: snapshots.isBaseline,
      rowCount: snapshots.rowCount,
      createdAt: snapshots.createdAt,
    })
    .from(snapshots)
    .where(eq(snapshots.tabId, activeTab.id))
    .orderBy(desc(snapshots.createdAt));

  // recent blobs for stats + headers
  const recent = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.tabId, activeTab.id))
    .orderBy(desc(snapshots.createdAt))
    .limit(TIMELINE_STATS_LIMIT + 1);

  const latest = recent[0] ?? null;
  const latestData = latest ? decodeSnapshot(latest.dataBlob) : null;
  const detectedKey = latestData ? detectKeyColumn(latestData) : null;

  // mini stats vs previous snapshot (GitHub-style "+2 −1 ~3" per entry)
  const statsFor = new Map<string, { add: number; rem: number; chg: number }>();
  for (let i = 0; i + 1 < recent.length; i++) {
    const newer = recent[i];
    const older = recent[i + 1];
    const d = diffSnapshots(decodeSnapshot(older.dataBlob), decodeSnapshot(newer.dataBlob), {
      keyColumn: activeTab.keyColumn ?? null,
    });
    statsFor.set(newer.id, {
      add: d.summary.addedRows,
      rem: d.summary.removedRows,
      chg: d.summary.changedRows,
    });
  }

  // resolve from/to
  const validId = (v: unknown): string | null =>
    typeof v === "string" && timeline.some((s) => s.id === v) ? v : null;

  let toId = validId(sp.to) ?? timeline[0]?.id ?? null;
  let fromId = validId(sp.from);
  if (toId && !fromId) {
    const toIdx = timeline.findIndex((s) => s.id === toId);
    const baseline = timeline.slice(toIdx).find((s) => s.isBaseline && s.id !== toId);
    fromId = baseline?.id ?? timeline[timeline.length - 1]?.id ?? null;
    if (fromId === toId) fromId = null;
  }
  if (fromId && toId && fromId === toId) {
    fromId = null;
    toId = timeline[0]?.id ?? null;
  }

  const toSnap = timeline.find((s) => s.id === toId) ?? null;
  const fromSnap = timeline.find((s) => s.id === fromId) ?? null;
  const diff = fromSnap && toSnap ? await getTabDiff(activeTab.id, fromSnap.id, toSnap.id) : null;

  const selectOptions = timeline.map((s) => ({
    id: s.id,
    label: `${s.isBaseline ? "★ " : ""}${absoluteTime(s.createdAt)} · ${s.trigger === "manual" ? "manual" : "scheduled"}`,
  }));

  const trackedCount = allTabs.filter((t) => t.tracked).length;

  return (
    <div className="min-h-dvh">
      <AppHeader user={user} />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* top bar */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground" render={<Link href="/" />}>
              <ArrowLeft className="size-4" /> All sheets
            </Button>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{sheet.title}</h1>
            <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
              {trackedCount}/{allTabs.length} tracked · {scheduleLabel(sheet).toLowerCase()}
              {sheet.nextRunAt ? ` · next ${relativeTime(sheet.nextRunAt).replace(" ago", "")}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" render={<a href={sheet.url} target="_blank" rel="noreferrer" />}>
              <ExternalLink className="size-4" /> Open in Sheets
            </Button>
            <ScheduleDialog sheet={sheet} />
            {toSnap ? (
              <form action={setBaseline}>
                <input type="hidden" name="spreadsheetId" value={sheet.id} />
                <input type="hidden" name="runId" value={toSnap.runId} />
                <Button
                  type="submit"
                  size="sm"
                  variant={toSnap.isBaseline ? "secondary" : "default"}
                >
                  {toSnap.isBaseline ? (
                    <>
                      <CheckCircle2 className="size-4" /> Collected here
                    </>
                  ) : (
                    <>
                      <Star className="size-4" /> Mark as collected
                    </>
                  )}
                </Button>
              </form>
            ) : null}
            <form action={snapshotNow}>
              <input type="hidden" name="spreadsheetId" value={sheet.id} />
              <Button type="submit" size="sm">
                <Camera className="size-4" /> Snapshot now
              </Button>
            </form>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="icon-sm" aria-label="More options">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<a href={sheet.url} target="_blank" rel="noreferrer" />}>
                  <ExternalLink /> Open in Google Sheets
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DeleteSheetDialog spreadsheetId={sheet.id} title={sheet.title} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[270px_1fr]">
          {/* timeline */}
          <aside className="rounded-xl border bg-card">
            <div className="border-b px-4 py-3">
              <h2 className="font-mono text-xs font-semibold uppercase tracking-wide">History</h2>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {activeTab.title} · {timeline.length} snapshot{timeline.length === 1 ? "" : "s"}
              </p>
            </div>
            {timeline.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {activeTab.tracked
                  ? "No snapshots yet."
                  : "This tab isn't tracked — enable it in tab settings."}
              </div>
            ) : (
              <ol className="relative max-h-[70vh] overflow-auto py-3">
                {/* the branch line */}
                <span aria-hidden className="absolute bottom-3 left-[13px] top-3 w-px bg-border" />
                {timeline.map((s) => {
                  const isTo = s.id === toId;
                  const isFrom = s.id === fromId;
                  const st = statsFor.get(s.id);
                  return (
                    <li key={s.id} className="relative pl-7 pr-2">
                      <Link
                        href={`/sheets/${sheet.id}?tab=${encodeURIComponent(activeTab.title)}&from=${fromId ?? ""}&to=${s.id}`}
                        className="group block rounded-md px-2 py-1.5 transition-colors hover:bg-muted/70"
                      >
                        {/* commit dot */}
                        <span
                          aria-hidden
                          className={`absolute left-[7px] top-[11px] size-[13px] rounded-full border-2 ${
                            isTo
                              ? "border-primary bg-primary"
                              : isFrom
                                ? "border-dashed border-muted-foreground bg-card"
                                : "border-border bg-card group-hover:border-muted-foreground/50"
                          }`}
                        />
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-mono text-xs font-semibold" title={absoluteTime(s.createdAt)}>
                            {relativeTime(s.createdAt)}
                          </span>
                          <span className="font-mono text-[10.5px] text-muted-foreground/80">
                            {s.trigger === "manual" ? "manual" : "auto"}
                          </span>
                          {s.isBaseline ? (
                            <span className="flex items-center gap-1 rounded-full bg-diff-move-bg px-1.5 py-px font-mono text-[10px] font-medium text-diff-move-fg dark:bg-amber-950/50 dark:text-amber-300">
                              <Star className="size-2.5 fill-current" /> collected
                            </span>
                          ) : null}
                          {isTo ? (
                            <span className="rounded-full bg-primary/10 px-1.5 py-px font-mono text-[10px] font-medium text-primary">
                              HEAD
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px]">
                          <span className="text-muted-foreground/70">{s.rowCount} rows</span>
                          {st && st.add + st.rem + st.chg > 0 ? (
                            <span className="flex gap-1.5">
                              {st.add > 0 && <span className="text-diff-add-fg dark:text-emerald-400">+{st.add}</span>}
                              {st.rem > 0 && <span className="text-diff-del-fg dark:text-red-400">−{st.rem}</span>}
                              {st.chg > 0 && <span className="text-diff-move-fg dark:text-amber-500">~{st.chg}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">no changes</span>
                          )}
                        </span>
                        {isFrom && !isTo ? (
                          <span className="mt-1 block w-fit rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                            diff base
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </aside>

          {/* diff panel */}
          <section className="min-w-0">
            {/* tab strip */}
            <div className="mb-4 flex flex-wrap items-end gap-1 border-b pb-0">
              {allTabs.map((t) => {
                const isActive = t.id === activeTab.id;
                return (
                  <Link
                    key={t.id}
                    href={`/sheets/${sheet.id}?tab=${encodeURIComponent(t.title)}`}
                    className={`-mb-px flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3.5 pb-2 pt-2 text-sm transition-colors ${
                      isActive
                        ? "border-border bg-card font-medium text-foreground shadow-[inset_0_2px_0_0_#fd8c73]"
                        : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <span className={`font-mono text-xs ${isActive ? "" : "opacity-60"}`}>{t.title}</span>
                    {!t.tracked ? <span className="font-mono text-[10px] text-muted-foreground/60">off</span> : null}
                  </Link>
                );
              })}
              <div className="ml-auto pb-2">
                <TabSettingsDialog
                  spreadsheetId={sheet.id}
                  tabId={activeTab.id}
                  tabTitle={activeTab.title}
                  headers={latestData?.headers ?? []}
                  keyColumn={activeTab.keyColumn}
                  tracked={activeTab.tracked}
                  detectedKey={detectedKey}
                />
              </div>
            </div>

            {timeline.length < 2 ? (
              <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed py-20 text-center">
                <Camera className="size-10 text-muted-foreground/50" />
                {timeline.length === 0 ? (
                  <>
                    <p className="font-medium">No snapshot yet</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Take the first snapshot to start versioning this tab.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">One snapshot so far</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Snapshot again after your team edits the sheet — SheetDiff will diff the two.
                    </p>
                  </>
                )}
                {activeTab.tracked ? (
                  <form action={snapshotNow}>
                    <input type="hidden" name="spreadsheetId" value={sheet.id} />
                    <Button type="submit">
                      <Camera className="size-4" /> Snapshot now
                    </Button>
                  </form>
                ) : null}
              </div>
            ) : !diff ? (
              <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">
                Couldn&rsquo;t load that diff. Pick two snapshots above.
              </div>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <SnapshotSelect
                    spreadsheetId={sheet.id}
                    tabParam={activeTab.title}
                    options={selectOptions}
                    from={fromId ?? ""}
                    to={toId ?? ""}
                  />
                  {fromSnap?.isBaseline ? (
                    <Badge variant="outline" className="gap-1 border-amber-300 bg-diff-move-bg font-mono text-[11px] text-diff-move-fg dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      <Clock className="size-3" /> since last collection
                    </Badge>
                  ) : (
                    <Link
                      href={`/sheets/${sheet.id}?tab=${encodeURIComponent(activeTab.title)}`}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <ArrowUpRight className="size-3" /> diff since last collection
                    </Link>
                  )}
                </div>
                <DiffView
                  result={diff}
                  tabTitle={activeTab.title}
                  fromLabel={fromSnap ? absoluteTime(fromSnap.createdAt) : "?"}
                  toLabel={toSnap ? absoluteTime(toSnap.createdAt) : "?"}
                />
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
