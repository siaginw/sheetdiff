import { redirect } from "next/navigation";
import { AlertCircle, ArrowRight, ClipboardPaste } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getSessionUser } from "@/lib/session";
import { parseSpreadsheetId, fetchSpreadsheetMeta, fetchTabValues, getUserClient } from "@/lib/google";
import { toSnapshotData } from "@/lib/snapshots";
import { detectKeyColumn } from "@/lib/diff/engine";
import { colLetter } from "@/lib/diff/normalize";
import { startTracking } from "@/lib/actions";

interface TabPreview {
  title: string;
  headers: string[];
  rowCount: number;
  detectedKey: number | null;
}

export default async function NewSheetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/");

  const params = await searchParams;
  const url = typeof params.url === "string" ? params.url.trim() : "";
  const error = typeof params.error === "string" ? params.error : null;

  let preview: { title: string; googleId: string; tabs: TabPreview[] } | null = null;
  let loadError: string | null = null;

  if (url) {
    const googleId = parseSpreadsheetId(url);
    if (!googleId) {
      loadError = "That doesn't look like a Google Sheets link. Paste the full URL, e.g. https://docs.google.com/spreadsheets/d/…";
    } else {
      try {
        const client = await getUserClient(user.id);
        const meta = await fetchSpreadsheetMeta(client, googleId);
        const values = await fetchTabValues(
          client,
          googleId,
          meta.tabs.map((t) => t.title),
        );
        preview = {
          title: meta.title,
          googleId,
          tabs: meta.tabs.map((t) => {
            const data = toSnapshotData(values[t.title] ?? []);
            return {
              title: t.title,
              headers: data.headers,
              rowCount: data.rows.length,
              detectedKey: detectKeyColumn(data),
            };
          }),
        };
      } catch {
        loadError =
          "Couldn't read that spreadsheet. Make sure the link is correct and the sheet is shared with your Google account (Viewer is enough).";
      }
    }
  }

  return (
    <div className="min-h-dvh">
      <AppHeader user={user} />
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add a sheet</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a link to a Google Sheet. SheetDiff reads it through Google&rsquo;s API — read-only.
        </p>

        <form method="GET" className="mt-6 flex gap-2">
          <div className="flex-1">
            <Label htmlFor="url" className="sr-only">
              Google Sheets URL
            </Label>
            <Input
              id="url"
              name="url"
              defaultValue={url}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              autoComplete="off"
            />
          </div>
          <Button type="submit">
            <ClipboardPaste className="size-4" /> Preview
          </Button>
        </form>

        {(error ?? loadError) ? (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              {error === "no-tabs" ? "Pick at least one tab to track." : loadError ?? error}
            </span>
          </div>
        ) : null}

        {preview ? (
          <form action={startTracking} className="mt-8">
            <input type="hidden" name="url" value={url} />
            <div className="rounded-xl border">
              <div className="border-b px-5 py-4">
                <p className="font-medium">{preview.title}</p>
                <p className="text-sm text-muted-foreground">
                  {preview.tabs.length} {preview.tabs.length === 1 ? "tab" : "tabs"} found · pick
                  which ones to track
                </p>
              </div>
              <ul className="divide-y">
                {preview.tabs.map((tab) => (
                  <li key={tab.title} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                    <Checkbox
                      id={`tab-${tab.title}`}
                      name="tab"
                      value={tab.title}
                      defaultChecked
                      className="mt-0"
                    />
                    <Label htmlFor={`tab-${tab.title}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block truncate font-medium">{tab.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {tab.rowCount} data {tab.rowCount === 1 ? "row" : "rows"}
                      </span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Match rows by</span>
                      <Select
                        name={`key_${tab.title}`}
                        defaultValue="auto"
                        items={[
                          {
                            value: "auto",
                            label: `Auto${
                              tab.detectedKey !== null
                                ? ` · ${colLetter(tab.detectedKey)} (${tab.headers[tab.detectedKey] || "untitled"})`
                                : " · row content"
                            }`,
                          },
                          ...tab.headers.map((h, i) => ({
                            value: String(i),
                            label: `${colLetter(i)} · ${h || "(untitled)"}`,
                          })),
                        ]}
                      >
                        <SelectTrigger className="h-8 w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            Auto
                            {tab.detectedKey !== null
                              ? ` · ${colLetter(tab.detectedKey)} (${tab.headers[tab.detectedKey] || "untitled"})`
                              : " · row content"}
                          </SelectItem>
                          {tab.headers.map((h, i) => (
                            <SelectItem key={i} value={String(i)}>
                              {colLetter(i)} · {h || "(untitled)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-6 flex items-center justify-between">
              <p className="max-w-sm text-xs text-muted-foreground">
                The first snapshot is taken immediately, so there&rsquo;s a before for every after.
              </p>
              <Button type="submit">
                Start tracking <ArrowRight className="size-4" />
              </Button>
            </div>
          </form>
        ) : null}
      </main>
    </div>
  );
}
