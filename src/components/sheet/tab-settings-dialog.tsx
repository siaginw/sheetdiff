"use client";

import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateTabSettings } from "@/lib/actions";
import { colLetter } from "@/lib/diff/normalize";

/** Per-tab settings: which column identifies rows, and whether to track the tab. */
export function TabSettingsDialog({
  spreadsheetId,
  tabId,
  tabTitle,
  headers,
  keyColumn,
  tracked,
  detectedKey,
}: {
  spreadsheetId: string;
  tabId: string;
  tabTitle: string;
  headers: string[];
  keyColumn: number | null;
  tracked: boolean;
  detectedKey: number | null;
}) {
  const [key, setKey] = useState(keyColumn === null ? "auto" : String(keyColumn));
  const [isTracked, setIsTracked] = useState(tracked);
  const [open, setOpen] = useState(false);

  const keyItems = [
    {
      value: "auto",
      label: `Auto${detectedKey !== null ? ` · ${colLetter(detectedKey)} (${headers[detectedKey] || "untitled"})` : " · row content"}`,
    },
    ...headers.map((h, i) => ({ value: String(i), label: `${colLetter(i)} · ${h || "(untitled)"}` })),
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Settings for ${tabTitle}`}>
            <Settings2 className="size-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={updateTabSettings} onSubmit={() => setOpen(false)}>
          <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
          <input type="hidden" name="tabId" value={tabId} />
          <input type="hidden" name="keyColumn" value={key} />
          <input type="hidden" name="tracked" value={isTracked ? "on" : "off"} />

          <DialogHeader>
            <DialogTitle>“{tabTitle}” settings</DialogTitle>
            <DialogDescription>
              How rows are identified between snapshots. Sorting or filtering the sheet in Google
              never creates false changes.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-right text-sm">Match rows by</Label>
              <Select
                items={keyItems}
                value={key}
                onValueChange={(v) => {
                  if (typeof v === "string") setKey(v);
                }}
              >
                <SelectTrigger className="col-span-3">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    Auto
                    {detectedKey !== null
                      ? ` · ${colLetter(detectedKey)} (${headers[detectedKey] || "untitled"})`
                      : " · row content"}
                  </SelectItem>
                  {headers.map((h, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {colLetter(i)} · {h || "(untitled)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="-mt-2 text-[11px] leading-snug text-muted-foreground">
              Used for diffs <em>and</em> for spotting tabs that copy other tabs. Pick a column whose
              value identifies a row (unique, filled in) — anything else falls back to smart
              detection, so a bad pick can&apos;t corrupt counts.
            </p>
            <div className="grid grid-cols-4 items-center gap-2">
              <Label htmlFor="track-tab" className="text-right text-sm">Tracked</Label>
              <div className="col-span-3 flex items-center gap-2">
                <Switch id="track-tab" checked={isTracked} onCheckedChange={setIsTracked} />
                <span className="text-xs text-muted-foreground">
                  Include this tab in snapshots and diffs
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
