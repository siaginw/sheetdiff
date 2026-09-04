import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listAccessibleSpreadsheets } from "@/lib/access";
import { db } from "@/lib/db";
import { snapshots, tabs, users } from "@/lib/db/schema";
import { relativeTime, scheduleLabel } from "@/lib/format";
import { googleConfigured } from "@/lib/google";
import { getPendingChanges, pureCopyTabIds } from "@/lib/pending";
import { getSessionUser } from "@/lib/session";
import { captureIsStale } from "@/lib/staleness";
import { and, eq, inArray } from "drizzle-orm";
import { AlertCircle, CheckCircle2, ExternalLink, GitCompareArrows, Plus, Star } from "lucide-react";

const ERROR_MESSAGES: Record<string, string> = {
  "google-not-configured":
    "Google sign-in isn't configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file (see README), then restart.",
  "no-refresh-token":
    "Google didn't return a refresh token. Revoke the app in your Google account permissions and try connecting again.",
  "demo-disabled":
    "The demo login is off on this server. Whoever runs SheetDiff can enable it to let people explore with sample data.",
  "app-secret-missing":
    "This server isn't configured completely — whoever runs SheetDiff needs to finish setup (see the README).",
  "oauth-failed": "Google sign-in failed. Please try again.",
  "demo-not-seeded": "The demo data isn't loaded. Whoever runs this server needs to run 'npm run seed-demo' first.",
  "oauth-state-mismatch": "Sign-in session expired. Please try again.",
  "oauth-missing-code": "Sign-in was incomplete. Please try again.",
};

interface SheetStatus {
  changes: number;
  unresolved: number;
  detail: { added: number; removed: number; changed: number };
  baselineAt: number | null;
  latestAt: number | null;
}

/** Pending changes across every tracked tab (shared resolver keeps the
 *  dashboard, CSV export, and digest in exact agreement). Distinguishes
 *  "no baseline" from "quiet day / nothing pending" so the badge never lies. */
async function getSheetStatus(tabRows: (typeof tabs.$inferSelect)[]): Promise<SheetStatus> {
  const status: SheetStatus = {
    changes: 0,
    unresolved: 0,
    detail: { added: 0, removed: 0, changed: 0 },
    baselineAt: null,
    latestAt: null,
  };
  const tracked = tabRows.filter((t) => t.tracked);
  // compilation tabs' pending changes are echoes of the working tabs — the
  // badge counts work to enter, and the same shot listed twice is one entry
  // (the billing page and both CSVs skip copies too, so all surfaces agree)
  const copyTabIds = await pureCopyTabIds(tabRows);

  // resolve baseline existence INDEPENDENTLY of the pending resolver — the
  // quiet-day short-circuit and latest===baseline both return null, but the
  // baseline still exists (the dashboard's "up to date" state)
  if (tracked.length > 0) {
    const { and, eq: eqOp, ne: neOp } = await import("drizzle-orm");
    const { snapshots } = await import("@/lib/db/schema");
    const baselines = await db
      .select({ tabId: snapshots.tabId, createdAt: snapshots.createdAt })
      .from(snapshots)
      .where(
        and(
          inArray(
            snapshots.tabId,
            tracked.map((t) => t.id),
          ),
          eqOp(snapshots.isBaseline, true),
          neOp(snapshots.trigger, "import"),
        ),
      );
    if (baselines.length > 0) {
      status.baselineAt = Math.max(...baselines.map((b) => b.createdAt));
    }
  }

  for (const tab of tracked) {
    const pending = await getPendingChanges(tab);
    if (!pending) continue;
    status.latestAt = Math.max(status.latestAt ?? 0, pending.latestAt);
    if (copyTabIds.has(tab.id)) continue;
    status.detail.added += pending.counts.added;
    status.detail.removed += pending.counts.removed;
    status.detail.changed += pending.counts.changed;
    status.unresolved += pending.counts.unresolved;
  }
  status.changes = status.detail.added + status.detail.removed + status.detail.changed;
  return status;
}

/** Derive the getting-started checklist from the database — completion is
 *  computed, never stored, so the card can't drift out of sync with reality. */
async function computeOnboarding(userId: string, ownSheetIds: string[]) {
  const { members } = await import("@/lib/db/schema");
  const userRow = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!userRow) return { show: false, steps: [], allDone: true };

  const hasSheets = ownSheetIds.length > 0;
  const ownTabIds = hasSheets
    ? (await db.select({ id: tabs.id }).from(tabs).where(inArray(tabs.spreadsheetId, ownSheetIds))).map((t) => t.id)
    : [];
  const hasBaseline =
    ownTabIds.length > 0 &&
    (
      await db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(and(inArray(snapshots.tabId, ownTabIds), eq(snapshots.isBaseline, true)))
        .limit(1)
    ).length > 0;
  const notified = Boolean(userRow.digestEmail || userRow.notifyUrl);
  const shared =
    hasSheets &&
    (await db.select({ id: members.id }).from(members).where(eq(members.ownerUserId, userId)).limit(1)).length > 0;

  const steps = [
    {
      id: "track",
      title: "Track your first sheet",
      detail: "Paste a Google Sheets link — SheetDiff snapshots it and diffs every change from then on.",
      done: hasSheets,
      href: "/sheets/new",
      cta: "Track a sheet",
    },
    {
      id: "collect",
      title: "Mark a collection point",
      detail:
        'After you pull data into your office system, click "Mark as collected" — everything after it is what still needs entering.',
      done: hasBaseline,
      href: hasSheets ? `/sheets/${ownSheetIds[0]}` : "/sheets/new",
      cta: "Open the sheet",
    },
    {
      id: "notify",
      title: "Get told when things change",
      detail:
        "Push notifications to your phone the moment a capture finds new work to enter, a daily digest email, or both.",
      done: notified,
      href: "/settings",
      cta: "Set up notifications",
    },
    {
      id: "share",
      title: "Share with your data collector",
      detail: "They see diffs and tick changes off as entered — the exact workflow of the person collecting your data.",
      done: shared,
      optional: true,
      href: hasSheets ? `/sheets/${ownSheetIds[0]}` : "/sheets/new",
      cta: "Share access",
    },
  ];
  const allDone = steps.every((s) => s.done);
  return {
    show: !allDone && !userRow.onboardingDismissedAt,
    steps,
    allDone,
  };
}

/** The little green/red block bar GitHub uses for diff sizes. */
function DiffStatBlocks({ added, removed, changed }: { added: number; removed: number; changed: number }) {
  const total = Math.max(1, added + removed + changed);
  const green = Math.max(added > 0 ? 1 : 0, Math.round((5 * added) / total));
  const amber = Math.round((5 * changed) / total);
  const red = Math.max(0, 5 - green - amber);
  return (
    <span className="flex items-center gap-[2px]" aria-hidden>
      {Array.from({ length: green }).map((_, i) => (
        <span key={`g${i}`} className="size-2 rounded-[2px] bg-emerald-500" />
      ))}
      {Array.from({ length: amber }).map((_, i) => (
        <span key={`a${i}`} className="size-2 rounded-[2px] bg-amber-400" />
      ))}
      {Array.from({ length: red }).map((_, i) => (
        <span key={`r${i}`} className="size-2 rounded-[2px] bg-red-400" />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* landing                                                             */
/* ------------------------------------------------------------------ */

const MINI_COLS = [4, 4, 10, 4];

function MiniCell({ v, w, tone }: { v: string; w: number; tone?: "add" | "del" }) {
  return (
    <span
      className={`shrink-0 px-1.5 ${
        tone === "add"
          ? "rounded-sm bg-diff-add-token font-semibold text-diff-add-fg"
          : tone === "del"
            ? "rounded-sm bg-diff-del-token font-semibold text-diff-del-fg"
            : ""
      }`}
      style={{ width: `${w + 2}ch` }}
    >
      {v}
    </span>
  );
}

function MiniSep() {
  return <span className="shrink-0 text-muted-foreground/40">│</span>;
}

function MiniNum({ v }: { v: string }) {
  return (
    <span className="w-7 shrink-0 text-right font-mono text-[10.5px] leading-none text-muted-foreground">{v}</span>
  );
}

function MiniSign({ v, tone }: { v: string; tone: "add" | "del" }) {
  return (
    <span
      className={`w-4 shrink-0 text-center font-mono text-sm leading-none font-bold ${
        tone === "add" ? "text-diff-add-fg" : "text-diff-del-fg"
      }`}
    >
      {v}
    </span>
  );
}

function MiniDiff() {
  const c = MINI_COLS;
  return (
    <div className="overflow-hidden rounded-xl border bg-card text-left shadow-xl shadow-black/5">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2.5">
        <span className="size-2 rounded-full bg-sky-400/70" />
        <span className="font-mono text-xs font-semibold">Daily Production Log</span>
        <span className="ml-auto flex gap-2 font-mono text-xs">
          <span className="text-diff-add-fg">+2</span>
          <span className="text-diff-del-fg">−1</span>
        </span>
      </div>
      <div className="py-2 font-mono text-xs">
        <div className="flex h-7 items-center gap-2 border-y border-diff-hunk-bg bg-diff-hunk-bg/50 px-4 text-[11px] text-diff-hunk-fg/80">
          <span className="tracking-widest">⋯⋯⋯</span>
          <span>14 unchanged rows</span>
        </div>
        <div className="flex h-8 items-center gap-2 bg-diff-del-bg px-4">
          <MiniSign v="−" tone="del" />
          <MiniNum v="12" />
          <MiniNum v="" />
          <MiniCell v="12" w={c[0]} />
          <MiniSep />
          <MiniCell v="Mo" w={c[1]} />
          <MiniSep />
          <MiniCell v="Plumbing" w={c[2]} />
          <MiniSep />
          <MiniCell v="55" w={c[3]} tone="del" />
        </div>
        <div className="flex h-8 items-center gap-2 bg-diff-add-bg px-4">
          <MiniSign v="+" tone="add" />
          <MiniNum v="" />
          <MiniNum v="12" />
          <MiniCell v="12" w={c[0]} />
          <MiniSep />
          <MiniCell v="Mo" w={c[1]} />
          <MiniSep />
          <MiniCell v="Plumbing" w={c[2]} />
          <MiniSep />
          <MiniCell v="75" w={c[3]} tone="add" />
        </div>
        <div className="flex h-8 items-center gap-2 bg-diff-add-bg px-4">
          <MiniSign v="+" tone="add" />
          <MiniNum v="" />
          <MiniNum v="15" />
          <MiniCell v="15" w={c[0]} />
          <MiniSep />
          <MiniCell v="Kim" w={c[1]} />
          <MiniSep />
          <MiniCell v="Paint" w={c[2]} />
          <MiniSep />
          <MiniCell v="30" w={c[3]} />
        </div>
      </div>
    </div>
  );
}

function Landing({ error }: { error: string | null }) {
  return (
    <div className="min-h-dvh">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2 font-mono font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
            <GitCompareArrows className="size-4" />
          </span>
          sheetdiff
        </div>
        <ThemeToggle />
      </div>
      <main className="mx-auto max-w-4xl px-4 pt-8 pb-24 sm:px-6">
        {error ? (
          <div className="mb-8 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{ERROR_MESSAGES[error] ?? "Something went wrong. Please try again."}</span>
          </div>
        ) : null}

        <section className="bg-graph-paper -mx-4 px-4 pt-8 pb-14 sm:-mx-6 sm:px-6">
          <p className="font-mono text-xs font-medium text-muted-foreground">
            $ sheetdiff init --sheets &ldquo;your team&rsquo;s google sheets&rdquo;
          </p>
          <h1 className="mt-4 max-w-2xl font-mono text-4xl leading-[1.1] font-bold tracking-tight text-balance sm:text-5xl">
            Your spreadsheets,
            <br />
            <span className="text-diff-add-fg">version controlled</span>
            <span className="text-diff-del-fg">.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-balance text-muted-foreground">
            SheetDiff snapshots your team&rsquo;s sheets and shows every change the way Word shows tracked changes — so
            nothing slips past the person who collects the data.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {googleConfigured() ? (
              <Button size="lg" render={<Link href="/auth/login" />}>
                Connect Google Sheets
              </Button>
            ) : (
              <div className="rounded-lg border border-dashed bg-card/80 p-4 text-sm text-muted-foreground">
                Sign-in isn&rsquo;t available yet — the administrator needs to finish setting up this instance.
              </div>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              or try the demo:{" "}
              {process.env.ENABLE_DEMO === "1" ? (
                <a href="/auth/demo" className="underline underline-offset-2 hover:text-foreground">
                  open the demo login
                </a>
              ) : (
                <code className="rounded bg-muted px-1.5 py-0.5">npm run seed-demo</code>
              )}
            </span>{" "}
          </div>
        </section>

        {/* trust strip: the questions every first-time visitor has */}
        <section className="mt-8 rounded-xl border bg-card p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="font-mono text-xs font-semibold text-foreground">Self-hosted and free</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Runs on your own machine — your sheet data never leaves it. No signup, no subscription, about 10 minutes
                of one-time setup.
              </p>
            </div>
            <div>
              <p className="font-mono text-xs font-semibold text-foreground">Read-only, forever</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Connects to Google with a view-only key. It can look at your sheets; it cannot edit, add, or delete
                anything in them.
              </p>
            </div>
            <div>
              <p className="font-mono text-xs font-semibold text-foreground">Your team changes nothing</p>
              <p className="mt-1 text-sm text-muted-foreground">
                They keep typing in the same Google Sheet. SheetDiff just watches — no add-on to install, no new tool to
                learn.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-4">
          <MiniDiff />
          <p className="mt-3 text-center font-mono text-[11px] text-muted-foreground">
            row 12 · Qty 55 → 75 · new row 15 — visible in one glance, forever
          </p>
        </section>

        <section className="mt-16 grid gap-x-10 gap-y-6 sm:grid-cols-3">
          {[
            [
              "snapshot",
              "Hourly, daily or weekly captures. Filters left on by teammates can never corrupt one — the API sees through them.",
            ],
            [
              "diff",
              "Added rows, removed rows, changed cells as old → new. Sorts and moves don't cry wolf — rows match by their key column.",
            ],
            [
              "collect",
              "One click marks everything as pulled. The dashboard answers the only question that matters: what changed since the last pull?",
            ],
          ].map(([term, text]) => (
            <div key={term}>
              <p className="font-mono text-xs font-semibold text-foreground">{term}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const user = await getSessionUser();

  if (!user) return <Landing error={error} />;

  const sheets = await listAccessibleSpreadsheets(user);
  // does this user OWN anything, or are they a pure viewer on someone else's sheets?
  const ownSheets = sheets.filter((s) => s.userId === user.id);

  // the getting-started checklist: owners only, until every step is done or
  // it's dismissed. Each step's completion is DERIVED from the database —
  // no separate state to drift out of sync.
  const onboarding = await computeOnboarding(
    user.id,
    ownSheets.map((s) => s.id),
  );

  const statuses = new Map<string, SheetStatus>();
  for (const sheet of sheets) {
    const tabRows = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id));
    statuses.set(sheet.id, await getSheetStatus(tabRows));
  }

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader user={user} />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {error ? (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{ERROR_MESSAGES[error] ?? "Something went wrong."}</span>
          </div>
        ) : null}

        {onboarding.show ? <OnboardingCard steps={onboarding.steps} allDone={onboarding.allDone} /> : null}

        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Your sheets</h1>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {sheets.length} tracked · ★ = last collection point
            </p>
          </div>
          <Button render={<Link href="/sheets/new" />}>
            <Plus className="size-4" /> Track a sheet
          </Button>
        </div>

        {sheets.length === 0 ? (
          <div className="bg-graph-paper flex flex-col items-center justify-center rounded-xl border border-dashed py-20 text-center">
            <p className="font-mono text-sm font-medium">No sheets tracked yet</p>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Paste a Google Sheets link and SheetDiff will snapshot it and diff every change from here on.
            </p>
            <Button className="mt-5" render={<Link href="/sheets/new" />}>
              <Plus className="size-4" /> Track your first sheet
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <ul className="divide-y">
              {sheets.map((sheet) => {
                const st = statuses.get(sheet.id)!;
                const d = st.detail;
                return (
                  <li
                    key={sheet.id}
                    className="group flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/sheets/${sheet.id}`}
                        className="flex items-center gap-1.5 font-medium hover:text-primary hover:underline"
                      >
                        <span className="truncate">{sheet.title}</span>
                        <ExternalLink className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                      </Link>
                      <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
                        <span className="truncate">
                          {scheduleLabel(sheet).toLowerCase()} · snapshot {relativeTime(sheet.lastSnapshotAt)}
                          {!st.baselineAt && " · nothing marked as collected yet"}
                        </span>
                        {captureIsStale(sheet) ? (
                          <span
                            tabIndex={0}
                            role="note"
                            className="ml-0.5 inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-400"
                            title={`Snapshots look overdue (last ${relativeTime(sheet.lastSnapshotAt)}) — check that SheetDiff is running and connected to Google. "Up to date" below is computed from stale data.`}
                          >
                            ⚠ stale
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      {st.baselineAt ? (
                        st.unresolved > 0 ? (
                          // changes present and not all entered

                          <Link
                            href={`/sheets/${sheet.id}`}
                            className="flex items-center gap-2.5 font-mono text-xs"
                            title={`${st.changes} change${st.changes === 1 ? "" : "s"} since collection ${relativeTime(st.baselineAt)} · ${st.unresolved} not yet entered in the office system`}
                          >
                            <span className="flex gap-1.5 font-semibold">
                              {d.added > 0 && <span className="text-diff-add-fg">+{d.added}</span>}
                              {d.removed > 0 && <span className="text-diff-del-fg">−{d.removed}</span>}
                              {d.changed > 0 && <span className="text-diff-move-fg">~{d.changed}</span>}
                            </span>
                            <DiffStatBlocks added={d.added} removed={d.removed} changed={d.changed} />
                            {st.unresolved < st.changes ? (
                              <span className="text-[10.5px] text-muted-foreground">{st.unresolved} to enter</span>
                            ) : null}
                          </Link>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="gap-1 bg-diff-add-bg font-mono text-[11px] font-medium text-diff-add-fg"
                          >
                            <CheckCircle2 className="size-3" /> up to date since collection
                          </Badge>
                        )
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground/70">
                          mark a snapshot as collected to track changes
                        </span>
                      )}
                      {st.baselineAt ? (
                        <span className="hidden items-center gap-1 font-mono text-[11px] text-muted-foreground sm:flex">
                          <Star className="size-3 fill-amber-500 text-amber-500" />
                          {relativeTime(st.baselineAt)}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
