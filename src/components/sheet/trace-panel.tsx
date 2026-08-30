import { ArrowDownRight, ArrowUpRight, PenLine } from "lucide-react";
import type { TraceEvent } from "@/lib/trace";
import { absoluteTime } from "@/lib/format";

/** Shot history: every value change of one traced row, newest first. */
export function TracePanel({
  traceKeyLabel,
  events,
  onClearHref,
}: {
  traceKeyLabel: string;
  events: TraceEvent[];
  onClearHref: string;
}) {
  return (
    <div className="mb-4 rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wide">
          History · “{traceKeyLabel}”
        </h3>
        <a href={onClearHref} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          clear
        </a>
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">
          No changes recorded for this shot across the recent snapshots.
        </p>
      ) : (
        <ul className="divide-y">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2.5 px-4 py-2.5 text-sm">
              <span className="mt-0.5 shrink-0">
                {e.kind === "added" ? (
                  <ArrowUpRight className="size-4 text-diff-add-fg" />
                ) : e.kind === "removed" ? (
                  <ArrowDownRight className="size-4 text-diff-del-fg" />
                ) : (
                  <PenLine className="size-4 text-diff-move-fg" />
                )}
              </span>
              <div className="min-w-0">
                <p className="font-mono text-xs text-muted-foreground">{absoluteTime(e.at)}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-xs">
                  {e.changes
                    .filter((c) => c.from !== "" || c.to !== "")
                    .map((c, j) => (
                      <span key={j}>
                        <span className="text-foreground/70">{c.header}:</span>{" "}
                        {e.kind === "added" ? (
                          <span className="font-semibold text-diff-add-fg">{c.to}</span>
                        ) : e.kind === "removed" ? (
                          <span className="font-medium text-diff-del-fg line-through">{c.from}</span>
                        ) : (
                          <>
                            <span className="font-medium text-diff-del-fg line-through decoration-diff-del-fg/60">
                              {c.from === "" ? "blank" : c.from}
                            </span>
                            <span className="mx-1 text-foreground/50">→</span>
                            <span className="font-semibold text-diff-add-fg">{c.to === "" ? "blank" : c.to}</span>
                          </>
                        )}
                      </span>
                    ))}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
