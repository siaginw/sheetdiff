import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Camera,
  CheckCircle2,
  Clock,
  Download,
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
import { tabs, snapshots, notes, changeAcks } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getTabDiff, decodeSnapshot } from "@/lib/snapshots";
import { diffSnapshots, detectKeyColumn } from "@/lib/diff/engine";
import { runChecks, computeFootage, type CheckFinding, type TabChecksInput } from "@/lib/checks";
import { computeIntroductions, isResolved } from "@/lib/sync";
import { getSheetAccess } from "@/lib/access";
import { absoluteTime, relativeTime, scheduleLabel } from "@/lib/format";
import { snapshotNow, setBaseline } from "@/lib/actions";
import { ChecksPanel } from "@/components/sheet/checks-panel";
import { ImportDialog } from "@/components/sheet/import-dialog";
import { NoteDialog } from "@/components/sheet/note-dialog";
import { TracePanel } from "@/components/sheet/trace-panel";
import { traceKey as traceKeyFn } from "@/lib/trace";
import { normalizeKey } from "@/lib/diff/normalize";

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

  const access = await getSheetAccess(id, user);
  if (!access) notFound();
  const sheet = access.sheet;
  const isOwner = access.role === "owner";

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

  // recent blobs for stats + headers — filter imports IN the query;
  // limit-then-filter would shrink the window on import-heavy timelines
  const recent = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.tabId, activeTab.id), ne(snapshots.trigger, "import")))
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

  // resolve from/to (after a GIS import, land on sheet → import)
  const validId = (v: unknown): string | null =>
    typeof v === "string" && timeline.some((s) => s.id === v) ? v : null;

  const importedParam = typeof sp.imported === "string" ? sp.imported : null;
  let toId: string | null;
  let fromId = validId(sp.from);
  if (importedParam && !fromId) {
    const importedSnap = timeline.find((s) => s.runId === importedParam && s.trigger === "import");
    toId = importedSnap?.id ?? null;
    fromId = importedSnap ? latest?.id ?? null : null;
  } else {
    toId = validId(sp.to) ?? timeline.find((s) => s.trigger !== "import")?.id ?? timeline[0]?.id ?? null;
  }
  if (toId && !fromId) {
    const toIdx = timeline.findIndex((s) => s.id === toId);
    const baseline = timeline.slice(toIdx).find((s) => s.isBaseline && s.id !== toId);
    fromId = baseline?.id ?? timeline[timeline.length - 1]?.id ?? null;
    if (fromId === toId) fromId = null;
  }
  if (fromId && toId && fromId === toId) {
    fromId = null;
    toId = timeline.find((s) => s.trigger !== "import")?.id ?? timeline[0]?.id ?? null;
  }

  const toSnap = timeline.find((s) => s.id === toId) ?? null;
  const fromSnap = timeline.find((s) => s.id === fromId) ?? null;
  const diff = fromSnap && toSnap ? await getTabDiff(activeTab.id, fromSnap.id, toSnap.id) : null;

  const selectOptions = timeline.map((s) => ({
    id: s.id,
    label: `${s.isBaseline ? "★ " : ""}${s.trigger === "import" ? "⭳ " : ""}${absoluteTime(s.createdAt)} · ${
      s.trigger === "import" ? "GIS import" : s.trigger === "manual" ? "manual" : "scheduled"
    }`,
  }));

  // ---- notes + acks ----
  const sheetNotes = await db
    .select()
    .from(notes)
    .where(eq(notes.spreadsheetId, sheet.id))
    .orderBy(desc(notes.createdAt));
  const rowNotes = new Map(
    sheetNotes.filter((n) => n.rowKey && n.tabId === activeTab.id).map((n) => [n.rowKey!, n.body]),
  );
  type SheetNote = (typeof sheetNotes)[number];
  const notesByRun = new Map<string, SheetNote[]>();
  for (const n of sheetNotes) {
    if (!n.runId) continue;
    const list = notesByRun.get(n.runId) ?? [];
    list.push(n);
    notesByRun.set(n.runId, list);
  }
  const ackRows = await db.select().from(changeAcks).where(eq(changeAcks.tabId, activeTab.id));
  const ackMap = new Map(ackRows.map((a) => [a.rowKey, a.ackedAt]));

  // resolve acks against per-row introduction times (walk between baseline and "to")
  const resolvedRows: Record<string, boolean> = {};
  if (diff && fromSnap && toSnap && ackMap.size > 0) {
    const between = recent.filter(
      (s) => s.createdAt > fromSnap.createdAt && s.createdAt <= toSnap.createdAt,
    );
    const introduced =
      between.length > 1
        ? computeIntroductions(
            between.map((s) => ({ createdAt: s.createdAt, data: decodeSnapshot(s.dataBlob) })),
            diff.rows,
          )
        : new Map<string, number>();
    for (const r of diff.rows) {
      if (r.status === "unchanged" || r.status === "moved") continue;
      resolvedRows[r.rowKey] = isResolved(ackMap, r.rowKey, introduced.get(r.rowKey) ?? toSnap.createdAt);
    }
  }

  // ---- shot history (trace) ----
  const traceParam = typeof sp.trace === "string" ? sp.trace.trim() : "";
  const traceKeyCol = activeTab.keyColumn ?? detectedKey;
  const traceEvents =
    traceParam && traceKeyCol !== null && recent.length > 1
      ? traceKeyFn(
          [...recent].reverse().map((s) => ({ createdAt: s.createdAt, data: decodeSnapshot(s.dataBlob) })),
          traceKeyCol,
          normalizeKey(traceParam),
        )
      : [];
  const traceHrefBase = `/sheets/${sheet.id}?tab=${encodeURIComponent(activeTab.title)}`;

  // ---- checks on latest snapshots of every tracked tab ----
  const checkFindings: CheckFinding[] = [];
  let footageNow: number | null = null;
  let footageDelta: number | null = null;
  let footageBaseLabel = "since previous snapshot";
  if (latestData) {
    const inputs: TabChecksInput[] = [];
    for (const t of allTabs.filter((t) => t.tracked)) {
      // exclude imports IN the query — limit(1) before filtering would drop
      // the tab entirely when its newest snapshot is a GIS import
      const tSnaps = await db
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.tabId, t.id), ne(snapshots.trigger, "import")))
        .orderBy(desc(snapshots.createdAt))
        .limit(1);
      const tSnap = tSnaps[0];
      if (tSnap) {
        inputs.push({ tabTitle: t.title, data: decodeSnapshot(tSnap.dataBlob), keyColumn: t.keyColumn ?? null });
      }
    }
    checkFindings.push(...runChecks(inputs));

    // footage ledger for the ACTIVE tab: total + delta since collection
    const activeFootage = computeFootage(latestData);
    if (activeFootage.stations) {
      footageNow = activeFootage.ft;
      const baselineSnap = recent.find((s) => s.isBaseline && s.id !== latest.id);
      const base = baselineSnap ?? recent[1] ?? null;
      if (base) {
        const baseFootage = computeFootage(decodeSnapshot(base.dataBlob));
        footageDelta = activeFootage.ft - baseFootage.ft;
        footageBaseLabel = baselineSnap ? "since collection" : "since previous snapshot";
      }
    }
  }

  const trackedCount = allTabs.filter((t) => t.tracked).length;

  const IMPORT_ERRORS: Record<string, string> = {
    "import-no-file": "Pick a file to import first.",
    "import-bad-file": "Couldn't read that file — use .csv or .xlsx.",
    "import-no-match":
      "Nothing imported: no tracked tab matched the file. For .csv, pick the tab it maps to; for .xlsx, sheet names must match your tabs.",
  };
  const importError =
    typeof sp.error === "string" ? (IMPORT_ERRORS[sp.error] ?? null) : null;

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader user={user} />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* top bar */}
        {importError ? (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{importError}</span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground" render={<Link href="/" />}>
              <ArrowLeft className="size-4" /> All sheets
            </Button>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="truncate">{sheet.title}</span>
              <a
                href={sheet.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Google Sheets"
                className="shrink-0 rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="size-4" />
              </a>
            </h1>
            <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
              {trackedCount}/{allTabs.length} tracked · {scheduleLabel(sheet).toLowerCase()}
              {sheet.nextRunAt ? ` · next ${relativeTime(sheet.nextRunAt).replace(" ago", "")}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isOwner ? (
              <ImportDialog
                spreadsheetId={sheet.id}
                tabs={allTabs.filter((t) => t.tracked).map((t) => ({ id: t.id, title: t.title }))}
              />
            ) : null}
            {isOwner ? <ScheduleDialog sheet={sheet} /> : null}
            {toSnap && toSnap.trigger !== "import" ? (
              <form action={setBaseline}>
                <input type="hidden" name="spreadsheetId" value={sheet.id} />
                <input type="hidden" name="runId" value={toSnap.runId} />
                <Button
                  type="submit"
                  size="sm"
                  variant={toSnap.isBaseline ? "secondary" : "outline"}
                >
                  {toSnap.isBaseline ? (
                    <>
                      <CheckCircle2 className="size-4 text-diff-move-fg" /> Collected here
                    </>
                  ) : (
                    <>
                      <Star className="size-4" /> Mark as collected
                    </>
                  )}
                </Button>
              </form>
            ) : null}
            {isOwner ? (
            <form action={snapshotNow}>
              <input type="hidden" name="spreadsheetId" value={sheet.id} />
              <Button type="submit" size="sm">
                <Camera className="size-4" /> Snapshot now
              </Button>
            </form>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="icon-sm" aria-label="More options">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<a href={`${sheet.id}/export`} />}>
                  <Download /> Download changes to enter (CSV)
                </DropdownMenuItem>
                <DropdownMenuItem render={<a href={sheet.url} target="_blank" rel="noreferrer" />}>
                  <ExternalLink /> Open in Google Sheets
                </DropdownMenuItem>
                {isOwner ? (
                  <>
                    <DropdownMenuSeparator />
                    <DeleteSheetDialog spreadsheetId={sheet.id} title={sheet.title} />
                  </>
                ) : null}
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
              <form method="GET" action={`/sheets/${sheet.id}`} className="mt-2 flex gap-1.5">
                <input type="hidden" name="tab" value={activeTab.title} />
                <input
                  name="trace"
                  defaultValue={traceParam}
                  placeholder="Trace a shot…"
                  className="h-7 w-full rounded-md border bg-card px-2 font-mono text-xs outline-none focus:border-ring"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-md border px-2 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  go
                </button>
              </form>
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
                  const runNotes = notesByRun.get(s.runId) ?? [];
                  const isImport = s.trigger === "import";
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
                                : isImport
                                  ? "rotate-45 border-diff-hunk-fg/60 bg-card"
                                  : "border-border bg-card group-hover:border-muted-foreground/50"
                          }`}
                        />
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-mono text-xs font-semibold" title={absoluteTime(s.createdAt)}>
                            {relativeTime(s.createdAt)}
                          </span>
                          <span className="font-mono text-[10.5px] text-muted-foreground/80">
                            {isImport ? "GIS import" : s.trigger === "manual" ? "manual" : "auto"}
                          </span>
                          {s.isBaseline ? (
                            <span className="flex items-center gap-1 rounded-full bg-diff-move-bg px-1.5 py-px font-mono text-[10px] font-medium text-diff-move-fg">
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
                              {st.add > 0 && <span className="text-diff-add-fg">+{st.add}</span>}
                              {st.rem > 0 && <span className="text-diff-del-fg">−{st.rem}</span>}
                              {st.chg > 0 && <span className="text-diff-move-fg">~{st.chg}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">{isImport ? "" : "no changes"}</span>
                          )}
                        </span>
                        {isFrom && !isTo ? (
                          <span className="mt-1 block w-fit rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                            diff base
                          </span>
                        ) : null}
                      </Link>
                      {runNotes.length > 0 ? (
                        <div className="mb-1 ml-2 mr-1 rounded-md bg-diff-hunk-bg/40 px-2 py-1">
                          {runNotes.slice(0, 2).map((n) => (
                            <p key={n.id} className="line-clamp-2 text-[11px] leading-snug text-foreground/75">
                              🗒 {n.body}
                            </p>
                          ))}
                        </div>
                      ) : null}
                      {!isImport ? (
                        <div className="absolute right-1 top-1.5 opacity-50 transition-opacity hover:opacity-100 focus-within:opacity-100">
                          <NoteDialog
                            spreadsheetId={sheet.id}
                            runId={s.runId}
                            tabId={activeTab.id}
                            existingNote={runNotes[0]?.body}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </aside>

          {/* diff panel */}
          <section className="min-w-0">
            {/* footage ledger */}
            {footageNow !== null ? (
              <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-2.5 font-mono text-xs">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">footage</span>
                <span className="text-sm font-semibold">
                  {footageNow.toLocaleString()} <span className="font-normal text-muted-foreground">ft</span>
                </span>
                <span className="text-muted-foreground">· {activeTab.title}</span>
                {footageDelta !== null && footageDelta !== 0 ? (
                  <span
                    className={`font-semibold ${
                      footageDelta > 0 ? "text-diff-add-fg" : "text-diff-del-fg"
                    }`}
                  >
                    {footageDelta > 0 ? "+" : "−"}
                    {Math.abs(footageDelta).toLocaleString()} ft {footageBaseLabel}
                  </span>
                ) : footageDelta === 0 ? (
                  <span className="text-muted-foreground">unchanged {footageBaseLabel}</span>
                ) : null}
              </div>
            ) : null}

            {/* shot history */}
            {traceParam ? (
              traceKeyCol !== null ? (
                <TracePanel traceKeyLabel={traceParam} events={traceEvents} onClearHref={traceHrefBase} />
              ) : (
                <div className="mb-4 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                  Tracing needs a key column — pick one in tab settings.
                </div>
              )
            ) : null}

            {/* gap linter */}
            {timeline.length > 0 ? <ChecksPanel findings={checkFindings} /> : null}

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
                {isOwner ? <TabSettingsDialog
                  spreadsheetId={sheet.id}
                  tabId={activeTab.id}
                  tabTitle={activeTab.title}
                  headers={latestData?.headers ?? []}
                  keyColumn={activeTab.keyColumn}
                  tracked={activeTab.tracked}
                  detectedKey={detectedKey}
                /> : null}
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
                {isOwner && activeTab.tracked ? (
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
                    <Badge variant="outline" className="gap-1 border-amber-300 bg-diff-move-bg font-mono text-[11px] text-diff-move-fg">
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
                  spreadsheetId={sheet.id}
                  tabId={activeTab.id}
                  resolvedRows={resolvedRows}
                  rowNotes={Object.fromEntries(rowNotes)}
                  fromLabel={fromSnap ? absoluteTime(fromSnap.createdAt) : "?"}
                  toLabel={
                    toSnap
                      ? `${absoluteTime(toSnap.createdAt)}${toSnap.trigger === "import" ? " · GIS import" : ""}`
                      : "?"
                  }
                />
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
