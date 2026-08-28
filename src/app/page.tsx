import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitCompareArrows,
  Plus,
  Star,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db } from "@/lib/db";
import { spreadsheets, tabs, snapshots } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { googleConfigured } from "@/lib/google";
import { relativeTime, scheduleLabel } from "@/lib/format";
import { decodeSnapshot } from "@/lib/snapshots";
import { diffSnapshots } from "@/lib/diff/engine";

const ERROR_MESSAGES: Record<string, string> = {
  "google-not-configured":
    "Google sign-in isn't configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file (see README), then restart.",
  "no-refresh-token":
    "Google didn't return a refresh token. Revoke the app in your Google account permissions and try connecting again.",
  "oauth-failed": "Google sign-in failed. Please try again.",
  "oauth-state-mismatch": "Sign-in session expired. Please try again.",
  "oauth-missing-code": "Sign-in was incomplete. Please try again.",
};

interface SheetStatus {
  changes: number;
  detail: { added: number; removed: number; changed: number };
  baselineAt: number | null;
  latestAt: number | null;
}

/** Changes on every tracked tab between the latest baseline run and now. */
async function getSheetStatus(sheetId: string, tabRows: (typeof tabs.$inferSelect)[]): Promise<SheetStatus> {
  const status: SheetStatus = { changes: 0, detail: { added: 0, removed: 0, changed: 0 }, baselineAt: null, latestAt: null };
  const tracked = tabRows.filter((t) => t.tracked);
  if (tracked.length === 0) return status;

  const all = await db
    .select()
    .from(snapshots)
    .where(inArray(snapshots.tabId, tracked.map((t) => t.id)))
    .orderBy(desc(snapshots.createdAt));

  for (const tab of tracked) {
    const tabSnaps = all.filter((s) => s.tabId === tab.id);
    if (tabSnaps.length === 0) continue;
    const latest = tabSnaps[0];
    status.latestAt = Math.max(status.latestAt ?? 0, latest.createdAt);
    const baseline = tabSnaps.find((s) => s.isBaseline && s.createdAt <= latest.createdAt) ?? null;
    if (baseline) status.baselineAt = Math.max(status.baselineAt ?? 0, baseline.createdAt);
    if (!baseline || baseline.id === latest.id) continue;

    const diff = diffSnapshots(decodeSnapshot(baseline.dataBlob), decodeSnapshot(latest.dataBlob), {
      keyColumn: tab.keyColumn ?? null,
      fromWhen: baseline.createdAt,
      toWhen: latest.createdAt,
    });
    status.detail.added += diff.summary.addedRows;
    status.detail.removed += diff.summary.removedRows;
    status.detail.changed += diff.summary.changedRows;
  }
  status.changes = status.detail.added + status.detail.removed + status.detail.changed;
  return status;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const user = await getSessionUser();

  if (!user) {
    return (
      <div className="min-h-dvh">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-4 sm:px-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <GitCompareArrows className="size-4" />
            </span>
            SheetDiff
          </div>
        </div>
        <main className="mx-auto max-w-4xl px-4 pb-24 pt-16 sm:px-6">
          {error ? (
            <div className="mb-8 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{ERROR_MESSAGES[error] ?? "Something went wrong. Please try again."}</span>
            </div>
          ) : null}
          <div className="text-center">
            <Badge variant="outline" className="mb-5">
              For teams that live in Google Sheets
            </Badge>
            <h1 className="mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
              See every change in your team&rsquo;s sheets
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-balance text-lg text-muted-foreground">
              SheetDiff takes snapshots of your spreadsheets and shows GitHub-style diffs — so the
              people collecting your data always know what changed since they last pulled it.
            </p>
            <div className="mt-8 flex justify-center">
              {googleConfigured() ? (
                <Button size="lg" render={<Link href="/auth/login" />}>
                  Connect Google Sheets
                </Button>
              ) : (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Finish setup first: run <code className="rounded bg-muted px-1.5 py-0.5">npm run setup</code> and
                  add your Google credentials to <code className="rounded bg-muted px-1.5 py-0.5">.env</code> (see
                  README).
                </div>
              )}
            </div>
          </div>
          <div className="mt-20 grid gap-4 sm:grid-cols-3">
            {[
              {
                icon: Camera,
                title: "Snapshots on a schedule",
                text: "Hourly, daily or weekly — or capture manually any time. Filters someone left on can never corrupt a snapshot.",
              },
              {
                icon: GitCompareArrows,
                title: "Diffs that make sense",
                text: "Added rows, removed rows, changed cells as old → new. Sorts and moves don't create false alarms.",
              },
              {
                icon: Star,
                title: "Mark as collected",
                text: "One click sets the baseline, so 'what changed since the last pull?' is always answered.",
              },
            ].map(({ icon: Icon, title, text }) => (
              <Card key={title}>
                <CardHeader>
                  <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted">
                    <Icon className="size-4" />
                  </div>
                  <CardTitle className="text-base">{title}</CardTitle>
                  <CardDescription>{text}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </main>
      </div>
    );
  }

  const sheets = await db
    .select()
    .from(spreadsheets)
    .where(eq(spreadsheets.userId, user.id))
    .orderBy(desc(spreadsheets.createdAt));

  const statuses = new Map<string, SheetStatus>();
  for (const sheet of sheets) {
    const tabRows = await db.select().from(tabs).where(eq(tabs.spreadsheetId, sheet.id));
    statuses.set(sheet.id, await getSheetStatus(sheet.id, tabRows));
  }

  return (
    <div className="min-h-dvh">
      <AppHeader user={user} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {error ? (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{ERROR_MESSAGES[error] ?? "Something went wrong."}</span>
          </div>
        ) : null}

        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Your sheets</h1>
            <p className="text-sm text-muted-foreground">
              {sheets.length === 0
                ? "Track a spreadsheet to start versioning it."
                : `${sheets.length} tracked ${sheets.length === 1 ? "spreadsheet" : "spreadsheets"}`}
            </p>
          </div>
          <Button render={<Link href="/sheets/new" />}>
            <Plus className="size-4" /> Add sheet
          </Button>
        </div>

        {sheets.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20 text-center">
            <Camera className="mb-4 size-10 text-muted-foreground/50" />
            <p className="font-medium">No sheets tracked yet</p>
            <p className="mt-1 mb-5 max-w-sm text-sm text-muted-foreground">
              Paste a Google Sheets link and SheetDiff will snapshot it and diff every change from
              here on.
            </p>
            <Button render={<Link href="/sheets/new" />}>
              <Plus className="size-4" /> Add your first sheet
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sheets.map((sheet) => {
              const st = statuses.get(sheet.id)!;
              const d = st.detail;
              const parts: string[] = [];
              if (d.added) parts.push(`+${d.added}`);
              if (d.removed) parts.push(`−${d.removed}`);
              if (d.changed) parts.push(`~${d.changed}`);
              return (
                <Card key={sheet.id} className="transition-shadow hover:shadow-md">
                  <CardHeader>
                    <CardTitle className="truncate text-base">
                      <Link href={`/sheets/${sheet.id}`} className="hover:underline">
                        {sheet.title}
                      </Link>
                    </CardTitle>
                    <CardDescription className="flex items-center gap-1.5">
                      {scheduleLabel(sheet)} · last snapshot {relativeTime(sheet.lastSnapshotAt)}
                    </CardDescription>
                    <CardAction>
                      <a
                        href={sheet.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open in Google Sheets"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </CardAction>
                  </CardHeader>
                  <CardFooter className="flex-col items-start gap-2 py-3">
                    {st.changes > 0 ? (
                      <Badge variant="destructive" className="gap-1">
                        <AlertCircle className="size-3" />
                        {st.changes} change{st.changes === 1 ? "" : "s"} since collection
                        {parts.length > 0 ? ` (${parts.join(" ")})` : ""}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        <CheckCircle2 className="size-3" />
                        Up to date since collection
                      </Badge>
                    )}
                    {st.baselineAt ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" /> collected {relativeTime(st.baselineAt)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">no baseline set yet</span>
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
