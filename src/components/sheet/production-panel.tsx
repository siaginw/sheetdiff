import { CalendarClock, ClipboardCheck, HardHat, Receipt, Ruler, Scale, TriangleAlert, Users } from "lucide-react";
import type { DateHygieneFinding, LateEntry, TotalsMismatch, OverplacementFinding, CrewBoard, AgingGap, OfficePipeline, InvoiceStatus } from "@/lib/production";
import { absoluteTime } from "@/lib/format";

const ft = (n: number) => n.toLocaleString("en-US");

function Section({
  icon,
  title,
  tone = "warn",
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone?: "warn" | "info";
  children: React.ReactNode;
}) {
  return (
    <div className="border-t px-4 py-2.5 first:border-t-0">
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon} {title}
      </p>
      <div className={tone === "warn" ? "space-y-0.5" : "space-y-0.5"}>{children}</div>
    </div>
  );
}

function Line({ tone, children }: { tone?: "danger" | "warn" | "muted" | "good"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "bg-diff-del-bg text-diff-del-fg"
      : tone === "warn"
        ? "bg-diff-move-bg text-diff-move-fg"
        : tone === "good"
          ? "bg-diff-add-bg text-diff-add-fg"
          : "bg-muted/60 text-foreground/80";
  return <p className={`rounded-md px-2 py-1 font-mono text-xs ${cls}`}>{children}</p>;
}

/**
 * The production report: everything the daily huddle argues about, generated —
 * date hygiene, backdated entries, TOTALS reconciliation, crew board, aging
 * holes, and the office-entry backlog the sheet's own entered-column carries.
 */
export function ProductionPanel({
  tabTitle,
  hygiene,
  lateEntries,
  totalsMismatches,
  overplacements,
  crewBoard,
  agedGaps,
  office,

  invoices,
}: {
  tabTitle: string;
  hygiene: DateHygieneFinding[];
  lateEntries: LateEntry[];
  totalsMismatches: TotalsMismatch[];
  overplacements: OverplacementFinding[];
  crewBoard: CrewBoard | null;
  agedGaps: AgingGap[];
  office: OfficePipeline | null;

  invoices: InvoiceStatus | null;
}) {
  const problems = hygiene.length + lateEntries.length + totalsMismatches.length + overplacements.length;
  const oldHoles = agedGaps.filter((g) => g.daysOpen >= 7);
  const officeWaiting = office && office.enteredColumn ? office.stuck.length + office.aging.length + office.normal.length : 0;
  // invoice findings count toward "clean"/empty-state the same as every other
  // section — the chips above used to render while the summary still said clean
  const invoiceChase =
    invoices && invoices.enteredColumn
      ? invoices.billableNow.length + invoices.missedRun.reduce((n, m) => n + m.rows, 0)
      : 0;
  const billableStuck = invoices ? invoices.billableNow.filter((r) => r.daysSinceCompletion >= 15) : [];
  const billableAging = invoices ? invoices.billableNow.filter((r) => r.daysSinceCompletion >= 3 && r.daysSinceCompletion < 15) : [];
  const billableFresh = invoices ? invoices.billableNow.filter((r) => r.daysSinceCompletion < 3) : [];

  return (
    <details className="group mb-4 rounded-xl border bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <HardHat className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          Production <span className="font-mono text-xs text-muted-foreground">· {tabTitle}</span>
        </span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          {crewBoard && crewBoard.crews.length > 0 && (
            <span>
              {crewBoard.crews.length} crew{crewBoard.crews.length === 1 ? "" : "s"} ·{" "}
              {ft(crewBoard.crews.reduce((n, c) => n + c.ft, 0))} ft placed
            </span>
          )}
          {hygiene.length > 0 && <span className="text-diff-del-fg">{hygiene.length} date issue{hygiene.length === 1 ? "" : "s"}</span>}
          {lateEntries.length > 0 && (
            <span className="text-diff-del-fg">
              {lateEntries.length} late entr{lateEntries.length === 1 ? "y" : "ies"}
            </span>
          )}
          {oldHoles.length > 0 && (
            <span className="text-diff-move-fg">
              {oldHoles.length} hole{oldHoles.length === 1 ? "" : "s"} open over a week
            </span>
          )}
          {totalsMismatches.length > 0 && (
            <span className="text-diff-del-fg">{totalsMismatches.length} TOTALS mismatch{totalsMismatches.length === 1 ? "" : "es"}</span>
          )}
          {overplacements.length > 0 && (
            <span className="text-diff-del-fg">
              {overplacements.length} over-placed (+
              {ft(overplacements.reduce((n, o) => n + o.overBy, 0))} ft)
            </span>
          )}
          {invoices && invoices.billableNow.length > 0 && (
            <span className="text-diff-move-fg">
              {invoices.billableNow.length} billable now (oldest {invoices.oldestAgeDays}d)
            </span>
          )}
          {invoices && invoices.missedRun.length > 0 && (
            <span className="text-diff-del-fg">{invoices.missedRun.reduce((n, m) => n + m.rows, 0)} missed invoice run</span>
          )}
          {office && office.stuck.length > 0 && (
            <span className="text-diff-del-fg">
              {office.stuck.length} stuck in office (oldest {office.stuck[0]!.daysWaiting}d)
            </span>
          )}
          {office && office.aging.length > 0 && (
            <span className="text-diff-move-fg">{office.aging.length} waiting on office entry</span>
          )}
          {problems === 0 && oldHoles.length === 0 && !(office && (office.stuck.length > 0 || office.aging.length > 0)) && invoiceChase === 0 && <span className="text-diff-add-fg">clean</span>}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground group-open:hidden">expand</span>
        <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground group-open:inline">collapse</span>
      </summary>

      {crewBoard && crewBoard.crews.length > 0 ? (
        <Section icon={<Users className="size-3.5" />} title="Crew board (placed footage)" tone="info">
          {crewBoard.crews.slice(0, 6).map((c) => (
            <Line key={c.crew}>
              {c.crew}: {ft(c.ft)} ft · {c.shots} shot{c.shots === 1 ? "" : "s"} · {c.days} day{c.days === 1 ? "" : "s"}
              {c.spellings && c.spellings > 1 ? (
                <span className="text-muted-foreground" title="Hand-spellings collapsed into this crew — the name shown is the one typed most">
                  {" "}· {c.spellings} spellings merged
                </span>
              ) : null}
            </Line>
          ))}
          {crewBoard.uncategorizedFt > 0 && (
            <Line tone="muted">{ft(crewBoard.uncategorizedFt)} ft with no crew named</Line>
          )}
        </Section>
      ) : null}

      {officeWaiting > 0 && office ? (
        <Section icon={<ClipboardCheck className="size-3.5" />} title={`Waiting on office entry (per the sheet's “${office.enteredColumn}” column)`}>
          {office.stuck.slice(0, 5).map((r) => (
            <Line key={`stuck-${r.row}`} tone="danger">
              row {r.row} · {r.activity} completed {r.completedOn} — {r.daysWaiting} day{r.daysWaiting === 1 ? "" : "s"} unentered
            </Line>
          ))}
          {office.stuck.length > 5 && <Line tone="muted">+{office.stuck.length - 5} more stuck…</Line>}
          {office.aging.slice(0, 5).map((r) => (
            <Line key={`aging-${r.row}`} tone="warn">
              row {r.row} · {r.activity} completed {r.completedOn} — {r.daysWaiting} day{r.daysWaiting === 1 ? "" : "s"} unentered
            </Line>
          ))}
          {office.aging.length > 5 && <Line tone="muted">+{office.aging.length - 5} more aging…</Line>}
          {office.normal.length > 0 && (
            <Line tone="muted">+{office.normal.length} completed within the last 2 days — normal keying lag</Line>
          )}
        </Section>
      ) : null}

      {invoices && invoices.enteredColumn && (invoices.billableNow.length > 0 || invoices.billedByInvoice.length > 0 || invoices.missedRun.length > 0) ? (
        <Section icon={<Receipt className="size-3.5" />} title={`Invoice ledger (per the sheet's “${invoices.enteredColumn}” column)`}>
          {invoices.missedRun.map((m) => (
            <Line key={`missed-${m.invoice}`} tone="danger">
              {m.invoice} run already passed — {m.rows} row{m.rows === 1 ? "" : "s"} never invoiced (chase the office)
            </Line>
          ))}
          {billableStuck.slice(0, 5).map((r) => (
            <Line key={`bill-${r.row}`} tone="danger">
              row {r.row} · {r.activity} · {ft(r.ft)} ft — completed {r.completedOn}, {r.daysSinceCompletion}d unentered
            </Line>
          ))}
          {billableStuck.length > 5 && <Line tone="muted">+{billableStuck.length - 5} more billable 15d+…</Line>}
          {billableAging.slice(0, 5).map((r) => (
            <Line key={`aging-${r.row}`} tone="warn">
              row {r.row} · {r.activity} · {ft(r.ft)} ft — completed {r.completedOn}, {r.daysSinceCompletion}d unentered
            </Line>
          ))}
          {billableAging.length > 5 && <Line tone="muted">+{billableAging.length - 5} more aging…</Line>}
          {billableFresh.length > 0 && (
            <Line tone="muted">+{billableFresh.length} billable, completed within the last 2 days</Line>
          )}
          {invoices.billedByInvoice.slice(0, 5).map((b) => (
            <Line key={`inv-${b.invoice}`} tone="muted">
              {b.invoice.startsWith("queued: ")
                ? `${b.invoice.slice(8)} run queued — ${b.rows} row${b.rows === 1 ? "" : "s"}`
                : `Invoice ${b.invoice} — ${b.rows} row${b.rows === 1 ? "" : "s"}`}
            </Line>
          ))}
          {invoices.billedByInvoice.length > 5 && <Line tone="muted">+{invoices.billedByInvoice.length - 5} more ledger lines…</Line>}
        </Section>
      ) : null}

      {lateEntries.length > 0 ? (
        <Section icon={<CalendarClock className="size-3.5" />} title="Late entries — showed up days after their date">
          {lateEntries.slice(0, 5).map((e, i) => (
            <Line key={i} tone="danger">
              sheet row {e.row} · {e.activity} dated {e.completedOn} — showed up {e.daysLate} days later ({absoluteTime(e.appearedAt)})
            </Line>
          ))}
          {lateEntries.length > 5 && <Line tone="muted">+{lateEntries.length - 5} more…</Line>}
        </Section>
      ) : null}

      {hygiene.length > 0 ? (
        <Section icon={<CalendarClock className="size-3.5" />} title="Date Complete issues">
          {hygiene.slice(0, 5).map((h, i) => (
            <Line key={i} tone="danger">
              row {h.row}: {h.kind === "undated" ? "no date" : h.kind === "unreadable" ? `unreadable date “${h.raw}”` : `dated in the future (${h.raw})`}
            </Line>
          ))}
          {hygiene.length > 5 && <Line tone="muted">+{hygiene.length - 5} more…</Line>}
        </Section>
      ) : null}

      {totalsMismatches.length > 0 ? (
        <Section icon={<Scale className="size-3.5" />} title="TOTALS doesn't add up">
          {totalsMismatches.slice(0, 5).map((m, i) => (
            <Line key={i} tone="danger">
              {m.tabTitle}: TOTALS says {ft(m.totalsSays)} ft · tab adds up to {ft(m.tabAddsUp)} ft ({m.delta > 0 ? "+" : "−"}
              {ft(Math.abs(m.delta))}) — stale formula range?
            </Line>
          ))}
        </Section>
      ) : null}

      {overplacements.length > 0 ? (
        <Section icon={<Ruler className="size-3.5" />} title="Placed more than designed">
          {overplacements.slice(0, 5).map((o, i) => (
            <Line key={i} tone="danger">
              {o.tabTitle}: placed {ft(o.placed)} ft of {ft(o.designed)} ft designed — {ft(o.overBy)} ft nobody
              designed (double-counted rows?)
            </Line>
          ))}
          {overplacements.length > 5 && <Line tone="muted">+{overplacements.length - 5} more…</Line>}
        </Section>
      ) : null}

      {agedGaps.length > 0 ? (
        <Section icon={<TriangleAlert className="size-3.5" />} title="Aging unaccounted holes">
          {agedGaps.slice(0, 5).map((g, i) => (
            <Line key={i} tone={g.daysOpen >= 7 ? "danger" : "muted"}>
              {ft(g.from)}–{ft(g.to)} · {ft(g.ft)} ft · open {g.daysOpen} day{g.daysOpen === 1 ? "" : "s"}
            </Line>
          ))}
        </Section>
      ) : null}

      {problems === 0 && agedGaps.length === 0 && officeWaiting === 0 && invoiceChase === 0 && (!crewBoard || crewBoard.crews.length === 0) ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">No production analytics available for this tab.</p>
      ) : null}
    </details>
  );
}
