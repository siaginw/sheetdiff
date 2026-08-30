import { AlertTriangle, CheckCircle2, CircleSlash, LayoutList } from "lucide-react";
import type { GapReport } from "@/lib/gaps";

function ft(n: number): string {
  return n.toLocaleString();
}

function SegmentList({
  title,
  segments,
  tone,
}: {
  title: string;
  segments: GapReport["unaccounted"];
  tone: "danger" | "known";
}) {
  if (segments.length === 0) return null;
  return (
    <div className="px-4 py-2">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">
        {segments.map((g, i) => (
          <li
            key={i}
            className={`flex items-baseline gap-3 rounded-md px-2 py-1 font-mono text-xs ${
              tone === "danger" ? "bg-diff-del-bg text-diff-del-fg" : "bg-muted/60 text-muted-foreground"
            }`}
          >
            <span className="font-semibold">
              {ft(g.from)} – {ft(g.to)}
            </span>
            <span>{ft(g.ft)} ft</span>
            <span className="ml-auto text-[10px] opacity-70">after row {g.afterRow}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The auto gap report: the bore/plow/gap chain, reconciled —
 * what's placed, what's booked as GAP, and what's simply missing.
 */
export function GapReportPanel({ report, tabTitle }: { report: GapReport; tabTitle: string }) {
  if (report.chainStart === null) return null;

  const unaccountedFt = report.unaccounted.reduce((n, g) => n + g.ft, 0);
  const knownFt = report.knownGaps.reduce((n, g) => n + g.ft, 0);
  const overlapFt = report.overlaps.reduce((n, g) => n + g.ft, 0);
  const clean = report.unaccounted.length === 0 && report.overlaps.length === 0;

  return (
    <details
      className={`group mb-4 rounded-xl border ${clean ? "border-emerald-200 bg-diff-add-bg/20" : "border-red-200 bg-diff-del-bg/20"} open:bg-card`}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        {clean ? (
          <CheckCircle2 className="size-4 text-diff-add-fg" />
        ) : (
          <AlertTriangle className="size-4 text-diff-del-fg" />
        )}
        <span className="text-sm font-medium">
          Gap report <span className="font-mono text-xs text-muted-foreground">· {tabTitle}</span>
        </span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px]">
          <span title="first chain station → last">{ft(report.chainStart!)} → {ft(report.chainEnd!)} ({ft(report.designedSpan!)} ft)</span>
          <span className="text-diff-add-fg" title="bore + plow footage">{ft(report.placedFt)} placed</span>
          {knownFt > 0 && (
            <span className="text-diff-move-fg" title="explicit GAP rows">{ft(knownFt)} known gaps</span>
          )}
          {unaccountedFt > 0 && (
            <span className="font-semibold text-diff-del-fg" title="holes nobody booked">{ft(unaccountedFt)} unaccounted</span>
          )}
          {overlapFt > 0 && (
            <span className="text-diff-del-fg" title="double-counted spans">{ft(overlapFt)} overlap</span>
          )}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground group-open:hidden">expand</span>
        <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground group-open:inline">collapse</span>
      </summary>

      <div className="border-t">
        {report.unaccounted.length === 0 && report.overlaps.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            <CircleSlash className="size-4 text-diff-add-fg" />
            Every station in the chain is accounted for — placed footage or booked gaps only.
          </p>
        ) : (
          <>
            <SegmentList title="Unaccounted — work it or gap it" segments={report.unaccounted} tone="danger" />
            <SegmentList title="Known gaps (booked as GAP)" segments={report.knownGaps} tone="known" />
            <SegmentList title="Overlaps (double-counted)" segments={report.overlaps} tone="danger" />
          </>
        )}
        {report.invalid > 0 ? (
          <p className="flex items-center gap-2 border-t px-4 py-2 font-mono text-[10.5px] text-muted-foreground">
            <LayoutList className="size-3.5" />
            {report.invalid} chain row{report.invalid === 1 ? "" : "s"} skipped — stations missing or backwards
          </p>
        ) : null}
      </div>
    </details>
  );
}
