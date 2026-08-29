"use client";

import { useState } from "react";
import { FileUp } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { importGis } from "@/lib/actions";

/**
 * Import a GIS export and diff it against the latest sheet snapshot.
 * CSV maps to one tab (chosen); XLSX tabs are matched by name automatically.
 */
export function ImportDialog({
  spreadsheetId,
  tabs,
}: {
  spreadsheetId: string;
  tabs: { id: string; title: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [tabId, setTabId] = useState(tabs[0]?.id ?? "");
  const [fileName, setFileName] = useState("");

  const isCsv = fileName.toLowerCase().endsWith(".csv");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <FileUp className="size-4" /> Compare GIS export
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={importGis}>
          <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
          <DialogHeader>
            <DialogTitle>Compare a GIS export</DialogTitle>
            <DialogDescription>
              Drop the latest GIS export and SheetDiff will diff it against your sheet — shots
              missing on either side, station mismatches, type disagreements.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="gis-file">Export file (.csv or .xlsx)</Label>
              <input
                id="gis-file"
                name="file"
                type="file"
                accept=".csv,.xlsx"
                required
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
                className="file:border-input file:bg-background file:text-foreground file:hover:bg-muted file:mr-3 file:rounded-md file:border file:px-3 file:py-1.5 file:text-sm text-sm text-muted-foreground"
              />
            </div>

            {isCsv ? (
              <div className="grid grid-cols-5 items-center gap-2">
                <Label className="col-span-2 text-right text-sm">Maps to tab</Label>
                <input type="hidden" name="tabId" value={tabId} />
                <Select
                  items={tabs.map((t) => ({ value: t.id, label: t.title }))}
                  value={tabId}
                  onValueChange={(v) => {
                    if (typeof v === "string") setTabId(v);
                  }}
                >
                  <SelectTrigger className="col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tabs.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {fileName
                  ? "Excel tabs will be matched to tracked tabs by name."
                  : "For .xlsx: tabs are matched by name. For .csv: pick which tab it maps to."}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={!fileName}>
              Import &amp; diff
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
