import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
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
import { tabs, snapshots, snapshotStats, notes, changeAcks } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getTabDiff, decodeSnapshot, latestNonImportSnapshots } from "@/lib/snapshots";
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
import { GapReportPanel } from "@/components/sheet/gap-report-panel";
import { ProductionPanel } from "@/components/sheet/production-panel";
import { computeGapReport } from "@/lib/gaps";
import {
  dateHygiene,
  detectLateEntries,
  reconcileTotals,
  computeCrewBoard,
  agingGaps,
} from "@/lib/production";
import { traceKey as traceKeyFn } from "@/lib/trace";


const TIMELINE_STATS_LIMIT = 30; // legacy on-demand fallback window
const TIMELINE_RENDER_CAP = 60;
const INTRO_WALK_WINDOW = 31; // blob budget: latest + baseline + walk

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

  const trackedTabs = allTabs.filter((t) => t.tracked);
  const latestDataByTab = new Map<string, { title: string; data: ReturnType<typeof decodeSnapshot> }>();
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

  // recent snapshots: metadata + capture-time stats (no blobs, no per-view diffs);
  // blobs are fetched below only for the pieces that need grid data
  const recentMeta = await db
    .select({
      id: snapshots.id,
      runId: snapshots.runId,
      trigger: snapshots.trigger,
      isBaseline: snapshots.isBaseline,
      rowCount: snapshots.rowCount,
      createdAt: snapshots.createdAt,
    })
    .from(snapshots)
    .where(and(eq(snapshots.tabId, activeTab.id), ne(snapshots.trigger, "import")))
    .orderBy(desc(snapshots.createdAt))
    .limit(sp.older === "1" ? 500 : TIMELINE_RENDER_CAP);

  // stats from the materialized table; legacy snapshots without stats fall
  // back to on-demand diff (bounded to the same window)
  const statsRows = recentMeta.length
    ? await db
        .select()
        .from(snapshotStats)
        .where(inArray(snapshotStats.snapshotId, recentMeta.map((m) => m.id)))
    : [];
  const statsById = new Map(statsRows.map((r) => [r.snapshotId, r]));

  // blobs only for the window the page actually renders: latest (headers/
  // analytics), baseline + walk (ack resolution), and trace history
  const neededIds = new Set<string>();
  const recentById = new Map(recentMeta.map((m) => [m.id, m]));
  const latestMeta = recentMeta[0] ?? null;
  if (latestMeta) neededIds.add(latestMeta.id);
  const baselineMeta = recentMeta.find((m) => m.isBaseline && m.id !== latestMeta?.id) ?? null;
  if (baselineMeta) neededIds.add(baselineMeta.id);
  for (const m of recentMeta.slice(0, INTRO_WALK_WINDOW)) neededIds.add(m.id);
  const blobRows = neededIds.size
    ? await db.select().from(snapshots).where(inArray(snapshots.id, [...neededIds]))
    : [];
  const blobById = new Map(blobRows.map((r) => [r.id, r]));

  type RecentEntry = (typeof recentMeta)[number] & { dataBlob?: Buffer };
  const recent: RecentEntry[] = recentMeta.map((m) => ({ ...m, dataBlob: blobById.get(m.id)?.dataBlob }));

  // stats for the timeline: materialized first, on-demand fallback (uses blobs
  // fetched above; pairs beyond the blob window show "—")
  const statsFor = new Map<string, { add: number; rem: number; chg: number } | null>();
  for (let i = 0; i < recentMeta.length; i++) {
    const cur = recentMeta[i]!;
    const stat = statsById.get(cur.id);
    if (stat) {
      statsFor.set(cur.id, { add: stat.added, rem: stat.removed, chg: stat.changed });
      continue;
    }
    const prev = recentMeta[i + 1];
    if (prev && blobById.has(cur.id) && blobById.has(prev.id)) {
      const d = diffSnapshots(decodeSnapshot(blobById.get(prev.id)!.dataBlob), decodeSnapshot(blobById.get(cur.id)!.dataBlob), {
        keyColumn: activeTab.keyColumn ?? null,
      });
      statsFor.set(cur.id, { add: d.summary.addedRows, rem: d.summary.removedRows, chg: d.summary.changedRows });
    } else {
      statsFor.set(cur.id, null); // unknown — render "—"
    }
  }

  const latest = latestMeta;
  const latestData = latest ? (blobById.get(latest.id) ? decodeSnapshot(blobById.get(latest.id)!.dataBlob) : null) : null;
  const detectedKey = latestData ? detectKeyColumn(latestData) : null;

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
            between.filter((s) => s.dataBlob).map((s) => ({ createdAt: s.createdAt, data: decodeSnapshot(s.dataBlob!) })),
            diff.rows,
          )
        : new Map<string, number>();
    for (const r of diff.rows) {
      if (r.status === "unchanged" || r.status === "moved") continue;
      resolvedRows[r.rowKey] = isResolved(ackMap, r.rowKey, introduced.get(r.rowKey) ?? toSnap.createdAt);
    }
  }

  // ---- shot history (trace): station number, free text, or row key ----
  const traceParam = typeof sp.trace === "string" ? sp.trace.trim() : "";
  const timelineOpen = sp.older === "1";
  const traceEvents =
    traceParam && recent.length > 1
      ? traceKeyFn(
          [...recent].filter((s) => s.dataBlob).reverse().map((s) => ({ createdAt: s.createdAt, data: decodeSnapshot(s.dataBlob!) })),
          traceParam,
        )
      : [];
  const traceHrefBase = `/sheets/${sheet.id}?tab=${encodeURIComponent(activeTab.title)}`;

  // ---- checks on latest snapshots of every tracked tab ----
  const checkFindings: CheckFinding[] = [];
  let activeFootage: ReturnType<typeof computeFootage> | null = null;
  let gapReport: ReturnType<typeof computeGapReport> | null = null;
  let footageDelta: number | null = null;
  let footageBaseLabel = "since previous snapshot";
  if (latestData) {
    // ONE query + ONE decode per tab for BOTH checks and TOTALS reconciliation
    const latestByTab = await latestNonImportSnapshots(trackedTabs.map((t) => t.id));
    const inputs: TabChecksInput[] = [];
    for (const t of trackedTabs) {
      const tSnap = latestByTab.get(t.id);
      if (tSnap) {
        const data = decodeSnapshot(tSnap.dataBlob);
        inputs.push({ tabTitle: t.title, data, keyColumn: t.keyColumn ?? null });
        latestDataByTab.set(t.id, { title: t.title, data });
      }
    }
    checkFindings.push(...runChecks(inputs));

    // footage ledger for the ACTIVE tab: total + delta since collection
    const f = computeFootage(latestData);
    gapReport = computeGapReport(latestData);
    if (f.stations) {
      activeFootage = f;
      const baselineSnap = recent.find((s) => s.isBaseline && s.id !== latest.id);
      const base = (baselineSnap && baselineSnap.dataBlob ? baselineSnap : recent.find((r) => r.dataBlob && r.id !== latest.id)) ?? null;
      if (base) {
        const baseFootage = computeFootage(decodeSnapshot(base.dataBlob!));
        footageDelta = f.ft - baseFootage.ft;
        footageBaseLabel = baselineSnap ? "since collection" : "since previous snapshot";
      }
    }
  }

  // ---- production analytics (active tab): hygiene, late entries, aging, crew ----
  let hygiene: ReturnType<typeof dateHygiene> = [];
  let lateEntries: ReturnType<typeof detectLateEntries> = [];
  let agedGaps: ReturnType<typeof agingGaps> = [];
  let crewBoard: ReturnType<typeof computeCrewBoard> | null = null;
  let totalsMismatches: ReturnType<typeof reconcileTotals> = [];
  if (latestData) {
    hygiene = dateHygiene(latestData);
    crewBoard = computeCrewBoard(latestData);
    if (recent.length > 1) {
      const walk = [...recent].filter((sn) => sn.dataBlob).reverse().map((sn) => ({ createdAt: sn.createdAt, data: decodeSnapshot(sn.dataBlob!) }));
      lateEntries = detectLateEntries(walk);
      agedGaps = agingGaps(walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })));
    }
    // TOTALS reconciliation when a TOTALS-like tab exists
    const totalsTab = allTabs.find((t) => /totals?|summary/i.test(t.title));
    if (totalsTab) {
      const totalsSnaps = await latestNonImportSnapshots([totalsTab.id]);
      const totalsSnap = totalsSnaps.get(totalsTab.id);
      if (totalsSnap) {
        const perTab = new Map<string, { title: string; ft: number }>();
        for (const t of trackedTabs) {
          const entry = latestDataByTab.get(t.id);
          if (entry) {
            perTab.set(t.title.toLowerCase(), { title: t.title, ft: computeFootage(entry.data).ft });
          }
        }
        totalsMismatches = reconcileTotals(decodeSnapshot(totalsSnap.dataBlob), perTab);
      }
    }
  }

  const trackedCount = trackedTabs.length;

  const IMPORT_ERRORS: Record<string, string> = {
    "snapshot-failed": "Couldn't reach Google for the snapshot — check the sheet is shared with your account and try again.",
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
                  title={
                    diff && diff.rows.some((r) => r.status !== "unchanged" && r.status !== "moved")
                      ? `${diff.rows.filter((r) => r.status !== "unchanged" && r.status !== "moved").length} unentered changes will be cleared — export your worklist first`
                      : undefined
                  }
                >
                  {toSnap.isBaseline ? (
                    <>
                      <CheckCircle2 className="size-4 text-diff-move-fg" /> Collected here
                    </>
                  ) : (
                    <>
                      <Star className="size-4" /> Mark as collected{!toSnap.isBaseline && diff && diff.rows.some((r) => r.status !== "unchanged" && r.status !== "moved") ? ` (${diff.rows.filter((r) => r.status !== "unchanged" && r.status !== "moved").length} to enter)` : ""}
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
                <DropdownMenuItem render={<a href={`${sheet.id}/export/billing`} />}>
                  <Download /> Billing-day packet (CSV)
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
          <aside className="order-2 rounded-xl border bg-card lg:order-1">
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
                  placeholder="Trace a shot or station…"
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
                {timeline.slice(0, timelineOpen ? timeline.length : TIMELINE_RENDER_CAP).map((s) => {
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
                              showing
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px]">
                          <span className="text-muted-foreground/70">{s.rowCount} rows</span>
                          {st == null ? (
                            <span className="text-muted-foreground/40" title="Change counts weren't recorded for snapshots this old">—</span>
                          ) : st.add + st.rem + st.chg > 0 ? (
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
                        <div className="absolute right-1 top-1.5 opacity-50 transition-opacity hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
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
                {timeline.length > 60 ? (
                  <li className="px-4 py-1.5">
                    <a
                      href={`${traceHrefBase}${fromId ? `&from=${fromId}` : ""}${toId ? `&to=${toId}` : ""}${traceParam ? `&trace=${encodeURIComponent(traceParam)}` : ""}${timelineOpen ? "" : "&older=1"}`}
                      className="font-mono text-[10.5px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {timelineOpen ? "show recent only" : `show ${timeline.length - 60} older snapshot${timeline.length - 60 === 1 ? "" : "s"}…`}
                    </a>
                  </li>
                ) : null}
              </ol>
            )}
          </aside>

          {/* diff panel */}
          <section className="order-1 min-w-0 lg:order-2">
            {/* footage ledger */}
            {activeFootage?.stations ? (
              <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-2.5 font-mono text-xs">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">footage</span>
                <span className="text-sm font-semibold">
                  {activeFootage.ft.toLocaleString()} <span className="font-normal text-muted-foreground">ft</span>
                </span>
                <span className="text-muted-foreground">· {activeTab.title}</span>
                {activeFootage.handholes > 0 ? (
                  <span className="text-muted-foreground">
                    · {activeFootage.handholes} handhole{activeFootage.handholes === 1 ? "" : "s"}
                  </span>
                ) : null}
                {activeFootage.gaps.count > 0 ? (
                  <span className="text-muted-foreground" title="explicit GAP rows in the sheet">
                    · {activeFootage.gaps.count} known gap{activeFootage.gaps.count === 1 ? "" : "s"} (
                    {activeFootage.gaps.ft.toLocaleString()} ft)
                  </span>
                ) : null}
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
              <TracePanel traceKeyLabel={traceParam} events={traceEvents} onClearHref={traceHrefBase} />
            ) : null}

            {/* auto gap report */}
            {timeline.length > 0 && gapReport ? (
              <GapReportPanel report={gapReport} tabTitle={activeTab.title} />
            ) : null}

            {/* production analytics */}
            {timeline.length > 0 && latestData ? (
              <ProductionPanel
                tabTitle={activeTab.title}
                hygiene={hygiene}
                lateEntries={lateEntries}
                totalsMismatches={totalsMismatches}
                crewBoard={crewBoard}
                agedGaps={agedGaps}
              />
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
