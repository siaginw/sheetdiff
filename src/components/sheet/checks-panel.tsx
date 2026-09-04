import type { CheckFinding } from "@/lib/checks";
import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";

/**
 * The gap linter results for this sheet — station continuity breaks,
 * duplicate shots, and cross-tab strays, computed on the latest snapshots.
 */
export function ChecksPanel({ findings }: { findings: CheckFinding[] }) {
  if (findings.length === 0) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-diff-add-bg/40 px-4 py-2.5 text-sm dark:border-emerald-900">
        <CheckCircle2 className="size-4 text-diff-add-fg" />
        <span className="font-medium">All checks pass</span>
        <span className="text-xs text-muted-foreground">station continuity, duplicate shots, cross-tab strays</span>
      </div>
    );
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  return (
    <details className="group mb-4 rounded-lg border border-red-200 bg-diff-del-bg/30 open:bg-card dark:border-red-900">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
        <AlertTriangle className={`size-4 ${errors > 0 ? "text-diff-del-fg" : "text-diff-move-fg"}`} />
        <span className="font-medium">
          {findings.length} check finding{findings.length === 1 ? "" : "s"}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "warnings"} · click to{" "}
          <span className="group-open:hidden">expand</span>
          <span className="hidden group-open:inline">collapse</span>
        </span>
      </summary>
      <ul className="divide-y border-t px-4 py-1">
        {findings.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5 py-2 text-sm">
            {f.kind === "gap" ? (
              <CircleSlash className="mt-0.5 size-4 shrink-0 text-diff-move-fg" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-diff-del-fg" />
            )}
            <span>
              <span className="font-mono text-xs text-muted-foreground">{f.tabTitle}</span> <span>{f.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
