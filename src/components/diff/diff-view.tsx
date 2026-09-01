"use client";

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpDown,
  CheckCircle2,
  Check,
  Minus,
  PenLine,
  Plus,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { NoteDialog } from "@/components/sheet/note-dialog";
import { toggleAck, ackAllUnentered } from "@/lib/actions";
import { wordDiff, shouldWordDiff } from "@/lib/diff/worddiff";
import { columnWidths } from "@/lib/diff/widths";
import { oldRowValues, type DiffResult, DiffRow } from "@/lib/diff/engine";

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function DiffStat({ s }: { s: DiffResult["summary"] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
      {s.addedRows > 0 && (
        <span className="font-medium text-diff-add-fg" title={`${s.addedRows} added ${s.addedRows === 1 ? "row" : "rows"}`}>
          +{s.addedRows} {s.addedRows === 1 ? "row" : "rows"}
        </span>
      )}
      {s.removedRows > 0 && (
        <span className="font-medium text-diff-del-fg" title={`${s.removedRows} removed ${s.removedRows === 1 ? "row" : "rows"}`}>
          −{s.removedRows} {s.removedRows === 1 ? "row" : "rows"}
        </span>
      )}
      {s.changedRows > 0 && (
        <span className="font-medium text-diff-move-fg" title={`${s.changedCells} changed ${s.changedCells === 1 ? "cell" : "cells"} in ${s.changedRows} ${s.changedRows === 1 ? "row" : "rows"}`}>
          ~{s.changedCells} {s.changedCells === 1 ? "cell" : "cells"}
        </span>
      )}
      {s.movedRows > 0 && (
        <span className="text-muted-foreground" title={`${s.movedRows} ${s.movedRows === 1 ? "row" : "rows"} moved position`}>
          →{s.movedRows} moved
        </span>
      )}
      {s.columnsAdded.map((c) => (
        <span key={`+${c}`} className="text-diff-add-fg">+col “{c}”</span>
      ))}
      {s.columnsRemoved.map((c) => (
        <span key={`-${c}`} className="text-diff-del-fg">−col “{c}”</span>
      ))}
      {s.addedRows + s.removedRows + s.changedRows === 0 && s.columnsAdded.length + s.columnsRemoved.length === 0 && (
        <span className="text-muted-foreground">no changes</span>
      )}
    </span>
  );
}

/** Trailing per-row actions: "synced ✓" acknowledgment + audit note. */
function RowActions({
  row,
  spreadsheetId,
  tabId,
  acked,
  note,
}: {
  row: DiffRow;
  spreadsheetId: string;
  tabId: string;
  acked: boolean;
  note?: string;
}) {
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-0.5 pr-1 transition-opacity ${
        acked ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100"
      }`}
    >
      <form action={toggleAck}>
        <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
        <input type="hidden" name="tabId" value={tabId} />
        <input type="hidden" name="rowKey" value={row.rowKey} />
        <input type="hidden" name="on" value={acked ? "0" : "1"} />
        <button
          type="submit"
          aria-label={acked ? "Mark as not yet entered" : "Mark as entered in the office system"}
          title={acked ? "Entered downstream — click to un-resolve" : "Mark as entered in the downstream system"}
          className={`rounded-md p-1 transition-colors ${
            acked
              ? "text-diff-add-fg"
              : "text-muted-foreground/50 hover:bg-muted hover:text-foreground"
          }`}
        >
          <Check className={`size-3.5 ${acked ? "fill-current" : ""}`} />
        </button>
      </form>
      <NoteDialog
        spreadsheetId={spreadsheetId}
        tabId={tabId}
        rowKey={row.rowKey}
        existingNote={note}
      />
    </span>
  );
}

function WordDiffValues({ from, to }: { from: string; to: string }) {
  return (
    <>
      {wordDiff(from, to).map((seg, i) =>
        seg.kind === "same" ? (
          <span key={i} className="text-muted-foreground">{seg.text}</span>
        ) : seg.kind === "removed" ? (
          <span key={i} className="rounded-sm bg-diff-del-token px-0.5 line-through decoration-diff-del-fg/60">{seg.text}</span>
        ) : (
          <span key={i} className="rounded-sm bg-diff-add-token px-0.5 font-semibold">{seg.text}</span>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* unified code view — the GitHub code-review look                     */
/* ------------------------------------------------------------------ */

type LineItem =
  | { kind: "gap"; count: number; id: string }
  | { kind: "ctx"; row: DiffRow; id: string }
  | { kind: "sign"; sign: "+" | "-"; row: DiffRow; changedCols: Set<number>; id: string }
  | { kind: "move"; row: DiffRow; id: string }
  | { kind: "note"; cells: DiffRow["cells"]; id: string };

function buildLines(rows: DiffRow[], changesOnly: boolean): LineItem[] {
  const out: LineItem[] = [];
  let pending = 0;
  const flushGap = () => {
    if (pending > 0) {
      out.push({ kind: "gap", count: pending, id: `gap-${out.length}` });
      pending = 0;
    }
  };
  for (const r of rows) {
    if (r.status === "unchanged") {
      if (changesOnly) pending++;
      else out.push({ kind: "ctx", row: r, id: `ctx-${r.newIndex}-${out.length}` });
      continue;
    }
    if (changesOnly) flushGap();
    if (r.status === "changed") {
      out.push({ kind: "sign", sign: "-", row: r, changedCols: new Set(r.cells.map((c) => c.col)), id: `del-${r.newIndex}-${out.length}` });
      out.push({ kind: "sign", sign: "+", row: r, changedCols: new Set(r.cells.map((c) => c.col)), id: `add-${r.newIndex}-${out.length}` });
      // the explicit "this VALUE changed" annotation under the −/+ pair
      out.push({ kind: "note", cells: r.cells, id: `note-${r.newIndex}-${out.length}` });
    } else if (r.status === "moved") {
      out.push({ kind: "move", row: r, id: `move-${r.newIndex}-${out.length}` });
    } else {
      out.push({ kind: "sign", sign: r.status === "added" ? "+" : "-", row: r, changedCols: new Set(), id: `${r.status}-${out.length}` });
    }
  }
  flushGap();
  return out;
}

function CodeLine({
  item,
  columns,
  widths,
  actions,
  dimmed,
}: {
  item: LineItem;
  columns: DiffResult["columns"];
  widths: number[];
  actions?: React.ReactNode;
  dimmed?: boolean;
}) {
  if (item.kind === "gap") {
    return (
      <div className="flex h-8 items-center gap-2 border-y border-diff-hunk-bg bg-diff-hunk-bg/50 px-3 font-mono text-[11px] text-diff-hunk-fg/80">
        <span className="tracking-widest">⋯⋯⋯</span>
        <span>{item.count} unchanged {item.count === 1 ? "row" : "rows"}</span>
      </div>
    );
  }

  if (item.kind === "note") {
    return (
      <div className="flex h-7 items-center gap-2 border-b border-diff-hunk-bg/60 bg-diff-hunk-bg/30 px-3 py-px font-mono text-[11px]">
        <span className="w-4 shrink-0 text-center font-bold text-diff-move-fg">~</span>
        <span className="w-[62px] shrink-0" />
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 pr-2">
          {item.cells.map((c) => (
            <span key={c.col} className="whitespace-nowrap">
              <span className="text-foreground/70">{c.header}:</span>{" "}
              {shouldWordDiff(c.from, c.to) ? (
                <WordDiffValues from={c.from} to={c.to} />
              ) : (
                <>
                  <span className="font-medium text-diff-del-fg line-through decoration-diff-del-fg/60">
                    {c.from === "" ? "blank" : c.from}
                  </span>
                  <span className="mx-1.5 text-foreground/50">→</span>
                  <span className="font-semibold text-diff-add-fg">
                    {c.to === "" ? "blank" : c.to}
                  </span>
                </>
              )}
            </span>
          ))}
        </span>
      </div>
    );
  }

  if (item.kind === "move") {
    return (
      <div className="group flex h-8 items-center gap-2 bg-diff-move-bg px-3 font-mono text-xs" title={`moved from row ${(item.row.oldIndex ?? 0) + 1}`}>
        <span className="flex w-4 shrink-0 justify-center">
          <ArrowUpDown className="size-3.5 text-diff-move-fg" />
        </span>
        <LineNumbers old={item.row.oldIndex} new={item.row.newIndex} />
        <Cells values={item.row.values} columns={columns} widths={widths} tone="move" changed={EMPTY_SET} />
        {actions}
      </div>
    );
  }

  const row = item.row;
  const isCtx = item.kind === "ctx";
  const sign = item.kind === "sign" ? item.sign : "";
  const values = item.kind === "sign" && item.sign === "-" ? oldRowValues(row) : row.values;
  const tone = isCtx ? "ctx" : sign === "+" ? "add" : "del";

  return (
    <div
      className={`group flex h-8 items-center gap-2 px-3 font-mono text-xs transition-opacity ${
        tone === "add"
          ? "bg-diff-add-bg"
          : tone === "del"
            ? "bg-diff-del-bg"
            : "text-muted-foreground"
      } ${dimmed ? "opacity-50" : ""}`}
    >
      <span
        className={`w-4 shrink-0 text-center text-sm font-bold leading-none ${
          tone === "add"
            ? "text-diff-add-fg"
            : tone === "del"
              ? "text-diff-del-fg"
              : ""
        }`}
      >
        {tone === "add" ? "+" : tone === "del" ? "−" : ""}
      </span>
      <LineNumbers
        old={tone === "add" ? null : row.oldIndex}
        new={tone === "del" ? null : row.newIndex}
      />
      <Cells
        values={values}
        columns={columns}
        widths={widths}
        tone={tone}
        changed={item.kind === "sign" ? item.changedCols : EMPTY_SET}
      />
      {actions}
    </div>
  );
}

function LineNumbers({ old, new: newIdx }: { old: number | null; new: number | null }) {
  return (
    <span className="flex shrink-0 select-none gap-1.5 font-mono text-[10.5px] leading-none text-foreground/55">
      <span className="w-7 text-right">{old !== null ? old + 1 : ""}</span>
      <span className="w-7 text-right">{newIdx !== null ? newIdx + 1 : ""}</span>
    </span>
  );
}

const EMPTY_SET = new Set<number>();

function Cells({
  values,
  columns,
  widths,
  tone,
  changed,
}: {
  values: string[];
  columns: DiffResult["columns"];
  widths: number[];
  tone: "add" | "del" | "ctx" | "move";
  changed: Set<number>;
}) {
  // GitHub convention: line text stays near-black on the tinted background —
  // only the changed token gets a saturated fill + text color. No
  // overflow-hidden here: clipping the flex children prevents the content's
  // width from reaching the scroll container, and wide sheets (40+ columns)
  // would silently lose their right-hand columns instead of scrolling.
  return (
    <span className="flex min-w-0 flex-1 items-center">
      {columns.map((c, i) => {
        const v = values[c.col] ?? "";
        const isChanged = changed.has(c.col) && tone !== "ctx";
        return (
          <span key={c.col} className="flex min-w-0 shrink-0 items-center">
            <span
              title={v}
              className={`truncate px-1.5 ${
                isChanged
                  ? tone === "add"
                    ? "rounded-sm bg-diff-add-token font-semibold"
                    : "rounded-sm bg-diff-del-token font-semibold"
                  : ""
              }`}
              style={{ width: `${widths[c.col] + 2}ch` }}
            >
              {v || "\u00A0"}
            </span>
            {i < columns.length - 1 && <span className="text-muted-foreground/40">│</span>}
          </span>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* table view (aligned grid — good for wide sheets)                    */
/* ------------------------------------------------------------------ */

function ChangedCell({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 py-1 font-mono text-xs leading-4">
      <span className="truncate rounded-sm bg-diff-del-token px-1 text-diff-del-fg line-through decoration-diff-del-fg/50" title={from}>
        {from || "\u00A0"}
      </span>
      <span className="truncate rounded-sm bg-diff-add-token px-1 text-diff-add-fg" title={to}>
        {to}
      </span>
    </div>
  );
}

const ROW_STYLE: Record<DiffRow["status"], string> = {
  added: "bg-diff-add-bg/70",
  removed: "bg-diff-del-bg/70",
  changed: "",
  moved: "bg-diff-move-bg/50",
  unchanged: "",
};

const ROW_ICON: Record<DiffRow["status"], React.ReactNode> = {
  added: <Plus className="size-3.5 text-diff-add-fg" />,
  removed: <Minus className="size-3.5 text-diff-del-fg" />,
  changed: <PenLine className="size-3.5 text-diff-move-fg" />,
  moved: <ArrowUpDown className="size-3.5 text-diff-move-fg" />,
  unchanged: null,
};

/* ------------------------------------------------------------------ */
/* the component                                                       */
/* ------------------------------------------------------------------ */

export function DiffView({
  result,
  fromLabel,
  toLabel,
  tabTitle,
  spreadsheetId,
  tabId,
  resolvedRows = {},
  rowNotes = {},
}: {
  result: DiffResult;
  fromLabel: string;
  toLabel: string;
  tabTitle: string;
  spreadsheetId: string;
  tabId: string;
  /** rowKey -> already acknowledged as entered downstream */
  resolvedRows?: Record<string, boolean>;
  /** rowKey -> note body */
  rowNotes?: Record<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [changesOnly, setChangesOnly] = useState(true);
  const [mode, setMode] = useState<"code" | "table">("code");
  const scrollRef = useRef<HTMLDivElement>(null);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      result.rows
        .filter(
          (r) =>
            r.values.some((v) => v.toLowerCase().includes(q)) ||
            (r.key?.toLowerCase().includes(q) ?? false),
        )
        .map((r) => r),
    );
  }, [query, result.rows]);

  const visibleRows = useMemo(
    () =>
      matching
        ? [...matching]
        : changesOnly
          ? result.rows.filter((r) => r.status !== "unchanged")
          : result.rows,
    [matching, changesOnly, result.rows],
  );

  // whole-tab unresolved count (search/filters don't shrink the batch): what
  // the "mark all entered" bulk action will actually ack
  const unackCount = useMemo(
    () =>
      result.rows.filter(
        (r) => r.status !== "unchanged" && r.status !== "moved" && resolvedRows[r.rowKey] !== true,
      ).length,
    [result.rows, resolvedRows],
  );

  const hasChanges =
    result.summary.addedRows + result.summary.removedRows + result.summary.changedRows > 0 ||
    result.summary.columnsAdded.length + result.summary.columnsRemoved.length > 0;

  const lines = useMemo(
    () => (matching ? buildLines([...matching], false) : buildLines(result.rows, changesOnly)),
    [matching, result.rows, changesOnly],
  );

  const widths = useMemo(
    // from VISIBLE rows only — hidden rows (changes-only filter, search) must
    // not stretch columns past anything on screen
    () => columnWidths(result, visibleRows),
    [result, visibleRows],
  );

  const codeVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 15,
    getItemKey: (i) => lines[i].id,
  });

  const tableVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 37,
    overscan: 10,
    getItemKey: (i) => `${visibleRows[i].status}-${visibleRows[i].oldIndex}-${visibleRows[i].newIndex}-${i}`,
  });

  // trailing actions column: grid mode must offer the same per-row
  // "mark entered"/note workflow as lines mode — wide-sheet users lost it
  const tableTemplate = `34px 56px repeat(${result.columns.length}, minmax(150px, 1fr)) 92px`;

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* file header, GitHub style */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/50 px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs font-semibold">
          <span className="size-2 shrink-0 rounded-full bg-diff-hunk-fg/30" />
          <span className="truncate">{tabTitle}</span>
        </span>
        <DiffStat s={result.summary} />
        {unackCount > 0 ? (
          <form action={ackAllUnentered}>
            <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
            <input type="hidden" name="tabId" value={tabId} />
            <button
              type="submit"
              title={`Mark all ${unackCount} unresolved ${unackCount === 1 ? "change" : "changes"} on this tab as entered in the office system (the pending set is recomputed server-side)`}
              className="flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CheckCircle2 className="size-3.5" />
              Mark all entered ({unackCount})
            </button>
          </form>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rows…"
              className="h-7 w-44 rounded-md pl-8 pr-12 font-sans text-xs"
            />
            {query ? (
              <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {(matching ? matching.size : 0) || "0"}
                </span>
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="size-3 rotate-45" />
                </button>
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2" title={query ? "Searching all rows — clear the search to filter to changes" : undefined}>
            <Switch
              id="changes-only"
              checked={query ? false : changesOnly}
              onCheckedChange={setChangesOnly}
              disabled={Boolean(query)}
            />
            <Label
              htmlFor="changes-only"
              className={`cursor-pointer text-xs ${query ? "text-muted-foreground/50" : "text-muted-foreground"}`}
            >
              {query ? "Searching all rows" : "Changes only"}
            </Label>
          </div>
          {/* mode toggle */}
          <div className="flex rounded-md border p-0.5 font-mono text-[11px]" aria-label="Diff layout">
            {(["code", "table"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-[5px] px-2 py-0.5 transition-colors ${
                  mode === m ? "bg-foreground font-semibold text-background" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "code" ? "lines" : "grid"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!hasChanges ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <CheckCircle2 className="size-10 text-diff-add-fg/60" />
          <p className="font-medium">No changes between these snapshots</p>
          <p className="text-sm text-muted-foreground">
            {fromLabel} → {toLabel}
            {result.summary.movedRows > 0
              ? ` · ${result.summary.movedRows} ${result.summary.movedRows === 1 ? "row" : "rows"} only moved position`
              : ""}
          </p>
        </div>
      ) : (mode === "code" ? lines : visibleRows).length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No rows match “{query}”.
        </div>
      ) : mode === "code" ? (
        <div ref={scrollRef} className="max-h-[calc(100dvh-300px)] min-h-72 overflow-auto">
          {/* column headers, laid out exactly like a code line so cells align;
              without them, added/removed rows are 3-4 unlabeled values */}
          <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 border-b bg-card/95 px-3 font-mono text-[10.5px] font-semibold text-muted-foreground backdrop-blur">
            <span className="w-4 shrink-0" />
            <span className="flex shrink-0 select-none gap-1.5 leading-none">
              <span className="w-7 text-right font-normal" title="row number in the older snapshot">old</span>
              <span className="w-7 text-right font-normal" title="row number in the newer snapshot">new</span>
            </span>
            <span className="flex min-w-0 flex-1 items-center overflow-hidden">
              {result.columns.map((c, i) => (
                <span key={c.col} className="flex min-w-0 shrink-0 items-center">
                  {/* text-xs, NOT the container's 10.5px: ch units resolve
                      differently per font-size and the headers must line up
                      with the text-xs cells below column-for-column */}
                  <span
                    className={`truncate px-1.5 text-xs ${c.status === "added" ? "text-diff-add-fg" : ""}`}
                    style={{ width: `${widths[c.col] + 2}ch` }}
                    title={c.header}
                  >
                    {c.header || "\u00A0"}
                  </span>
                  {i < result.columns.length - 1 && <span className="text-xs text-muted-foreground/40">│</span>}
                </span>
              ))}
            </span>
          </div>
          <div style={{ height: codeVirtualizer.getTotalSize(), position: "relative" }}>
            {codeVirtualizer.getVirtualItems().map((vr) => {
              const item = lines[vr.index];
              // one set of row actions per row: on "+" lines and removed "-" lines
              const isChangeLine =
                item.kind === "sign" && (item.sign === "+" || item.row.status === "removed");
              const row = "row" in item ? item.row : null;
              const acked = row !== null && resolvedRows[row.rowKey] === true;
              return (
                <div
                  key={vr.key}
                  data-index={vr.index}
                  ref={codeVirtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vr.start}px)` }}
                >
                  <CodeLine
                    item={item}
                    columns={result.columns}
                    widths={widths}
                    dimmed={isChangeLine && acked}
                    actions={
                      isChangeLine && row ? (
                        <RowActions
                          row={row}
                          spreadsheetId={spreadsheetId}
                          tabId={tabId}
                          acked={acked}
                          note={rowNotes[row.rowKey]}
                        />
                      ) : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="max-h-[calc(100dvh-300px)] min-h-72 overflow-auto">
          <div style={{ minWidth: 90 + result.columns.length * 150 }}>
            <div
              className="sticky top-0 z-10 grid border-b bg-card/95 backdrop-blur"
              style={{ gridTemplateColumns: tableTemplate }}
            >
              <div className="py-2" />
              <div className="py-2 text-center font-mono text-[10px] font-medium text-muted-foreground">#</div>
              {result.columns.map((c) => (
                <div
                  key={c.col}
                  className={`truncate px-2.5 py-2 text-xs font-semibold ${c.status === "added" ? "text-diff-add-fg" : ""}`}
                  title={c.header}
                >
                  {c.header}
                  {c.status === "added" ? " +" : ""}
                </div>
              ))}
              <div className="py-2 text-center font-mono text-[10px] font-medium text-muted-foreground" title="Mark as entered / add a note">act</div>
            </div>
            <div style={{ height: tableVirtualizer.getTotalSize(), position: "relative" }}>
              {tableVirtualizer.getVirtualItems().map((vr) => {
                const r = visibleRows[vr.index];
                const changedCols = new Set(r.cells.map((c) => c.col));
                return (
                  <div
                    key={vr.key}
                    data-index={vr.index}
                    ref={tableVirtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vr.start}px)`,
                      gridTemplateColumns: tableTemplate,
                    }}
                    className={`group/grid grid items-stretch border-b border-border/50 text-sm ${ROW_STYLE[r.status]}`}
                  >
                    <div className="flex items-center justify-center">{ROW_ICON[r.status]}</div>
                    <div className="flex flex-col items-end justify-center gap-0.5 px-2 py-1 font-mono text-[10px] leading-3.5 text-muted-foreground/70">
                      <span>{r.oldIndex !== null ? r.oldIndex + 1 : ""}</span>
                      <span>{r.newIndex !== null ? r.newIndex + 1 : ""}</span>
                    </div>
                    {result.columns.map((c) => {
                      const cell = changedCols.has(c.col) ? r.cells.find((x) => x.col === c.col) : null;
                      return (
                        <div key={c.col} className="min-w-0 px-2.5 py-1.5">
                          {cell ? (
                            <ChangedCell from={cell.from} to={cell.to} />
                          ) : (
                            <span
                              className={`block truncate px-1 font-mono text-xs leading-4 ${r.status === "removed" ? "text-diff-del-fg/80" : ""}`}
                              title={r.values[c.col] ?? ""}
                            >
                              {r.values[c.col] ?? ""}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <div
                      className={`flex items-center justify-end px-1 ${resolvedRows[r.rowKey] === true ? "opacity-100" : "opacity-0 group-hover/grid:opacity-100 max-md:opacity-100"}`}
                    >
                      {r.status === "unchanged" || r.status === "moved" ? null : (
                        <RowActions
                          row={r}
                          spreadsheetId={spreadsheetId}
                          tabId={tabId}
                          acked={resolvedRows[r.rowKey] === true}
                          note={rowNotes[r.rowKey]}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2 font-mono text-[11px] text-muted-foreground">
        <span>
          {mode === "code" ? lines.length : visibleRows.length} {mode === "code" ? "lines" : "rows"} shown ·{" "}
          {result.rows.length} total {result.rows.length === 1 ? "row" : "rows"}
        </span>
        <span className="flex items-center gap-2">
          <span>
            {result.summary.keyColumnHeader
              ? `matched by “${result.summary.keyColumnHeader}”`
              : "matched by row content"}
          </span>
          <span className="text-muted-foreground/50">|</span>
          <span>{fromLabel} → {toLabel}</span>
        </span>
      </div>
    </div>
  );
}
