"use client";

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpDown,
  CheckCircle2,
  Dot,
  Minus,
  PenLine,
  Plus,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { DiffResult, DiffRow } from "@/lib/diff/engine";

const STATUS_STYLES: Record<
  DiffRow["status"],
  { row: string; icon: React.ReactNode; label: string }
> = {
  added: {
    row: "bg-emerald-50/70 dark:bg-emerald-950/25",
    icon: <Plus className="size-3.5 text-emerald-600 dark:text-emerald-400" />,
    label: "added",
  },
  removed: {
    row: "bg-red-50/70 dark:bg-red-950/25",
    icon: <Minus className="size-3.5 text-red-600 dark:text-red-400" />,
    label: "removed",
  },
  changed: {
    row: "",
    icon: <PenLine className="size-3.5 text-amber-600 dark:text-amber-400" />,
    label: "changed",
  },
  moved: {
    row: "bg-amber-50/50 dark:bg-amber-950/15",
    icon: <ArrowUpDown className="size-3.5 text-amber-600 dark:text-amber-400" />,
    label: "moved",
  },
  unchanged: {
    row: "",
    icon: <Dot className="size-3.5 text-muted-foreground/40" />,
    label: "",
  },
};

function SummaryChips({ summary }: { summary: DiffResult["summary"] }) {
  const chips: { text: string; className: string }[] = [];
  if (summary.addedRows)
    chips.push({ text: `+${summary.addedRows} added ${summary.addedRows === 1 ? "row" : "rows"}`, className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" });
  if (summary.removedRows)
    chips.push({ text: `−${summary.removedRows} removed ${summary.removedRows === 1 ? "row" : "rows"}`, className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300" });
  if (summary.changedRows)
    chips.push({ text: `~${summary.changedCells} cell ${summary.changedCells === 1 ? "change" : "changes"} in ${summary.changedRows} ${summary.changedRows === 1 ? "row" : "rows"}`, className: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" });
  if (summary.movedRows)
    chips.push({ text: `${summary.movedRows} moved`, className: "bg-muted text-muted-foreground" });
  for (const c of summary.columnsAdded)
    chips.push({ text: `+ column “${c}”`, className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" });
  for (const c of summary.columnsRemoved)
    chips.push({ text: `− column “${c}”`, className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300" });
  if (chips.length === 0)
    chips.push({ text: "no changes", className: "bg-muted text-muted-foreground" });
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span key={i} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.className}`}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

function ChangedCell({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1 font-mono text-xs leading-4">
      <span className="truncate bg-red-100/70 px-1 text-red-700 line-through decoration-red-400/60 dark:bg-red-950/40 dark:text-red-300" title={from}>
        {from || "\u00A0"}
      </span>
      <span className="truncate bg-emerald-100/70 px-1 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" title={to}>
        {to}
      </span>
    </div>
  );
}

export function DiffView({
  result,
  fromLabel,
  toLabel,
}: {
  result: DiffResult;
  fromLabel: string;
  toLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [changesOnly, setChangesOnly] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return result.rows.filter((r) => {
      if (q)
        return (
          r.values.some((v) => v.toLowerCase().includes(q)) ||
          (r.key?.toLowerCase().includes(q) ?? false)
        );
      return changesOnly ? r.status !== "unchanged" : true;
    });
  }, [query, changesOnly, result.rows]);

  const hasChanges =
    result.summary.addedRows + result.summary.removedRows + result.summary.changedRows > 0 ||
    result.summary.columnsAdded.length + result.summary.columnsRemoved.length > 0;

  const template = `34px 56px repeat(${result.columns.length}, minmax(150px, 1fr))`;
  const minWidth = 82 + result.columns.length * 150;

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 37,
    overscan: 10,
    getItemKey: (i) => `${visible[i].status}-${visible[i].oldIndex}-${visible[i].newIndex}-${i}`,
  });

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3">
        <SummaryChips summary={result.summary} />
        <div className="ml-auto flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rows…"
              className="h-8 w-48 pl-8 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="changes-only" checked={changesOnly} onCheckedChange={setChangesOnly} />
            <Label htmlFor="changes-only" className="cursor-pointer text-xs text-muted-foreground">
              Changes only
            </Label>
          </div>
        </div>
      </div>

      {!hasChanges ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <CheckCircle2 className="size-10 text-emerald-500/70" />
          <p className="font-medium">No changes between these snapshots</p>
          <p className="text-sm text-muted-foreground">
            {fromLabel} → {toLabel}
            {result.summary.movedRows > 0
              ? ` · ${result.summary.movedRows} ${result.summary.movedRows === 1 ? "row" : "rows"} only moved position`
              : ""}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No rows match “{query}”.
        </div>
      ) : (
        <div ref={scrollRef} className="max-h-[calc(100dvh-320px)] min-h-72 overflow-auto">
          <div style={{ minWidth }}>
            {/* header */}
            <div
              className="sticky top-0 z-10 grid border-b bg-card/95 backdrop-blur"
              style={{ gridTemplateColumns: template }}
            >
              <div className="px-1 py-2" />
              <div className="py-2 text-center text-[10px] font-medium text-muted-foreground">#</div>              {result.columns.map((c) => (
                <div
                  key={c.col}
                  className={`truncate px-2.5 py-2 text-xs font-semibold ${c.status === "added" ? "text-emerald-700 dark:text-emerald-400" : ""}`}
                  title={c.header}
                >
                  {c.header}
                  {c.status === "added" ? " +" : ""}
                </div>
              ))}
            </div>
            {/* virtualized rows */}
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vr) => {
                const r = visible[vr.index];
                const st = STATUS_STYLES[r.status];
                const changedCols = new Set(r.cells.map((c) => c.col));
                return (
                  <div
                    key={vr.key}
                    data-index={vr.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vr.start}px)`,
                      gridTemplateColumns: template,
                    }}
                    className={`grid items-stretch border-b border-border/50 text-sm ${st.row}`}
                  >
                    <div className="flex items-center justify-center px-1">{st.icon}</div>
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
                                className={`block truncate font-mono text-xs leading-4 ${r.status === "removed" ? "text-red-800/80 dark:text-red-300/70" : ""}`}
                                title={r.values[c.col] ?? ""}
                              >
                                {r.values[c.col] ?? ""}
                              </span>
                            )}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {visible.length} of {result.rows.length} {result.rows.length === 1 ? "row" : "rows"} shown
          {result.summary.keyColumnHeader
            ? ` · rows matched by “${result.summary.keyColumnHeader}”`
            : " · rows matched by content"}
        </span>
        <span className="font-mono">
          {fromLabel} → {toLabel}
        </span>
      </div>
    </div>
  );
}
