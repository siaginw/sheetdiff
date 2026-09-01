"use client";

import { useState } from "react";
import { CheckCircle2, Star } from "lucide-react";
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
import { setBaseline } from "@/lib/actions";

/**
 * "Mark as collected" with a guard: when unentered changes remain anywhere in
 * the sheet, one misclick next to "Snapshot now" would permanently empty the
 * to-enter worklist (re-baselining resets the pending window). The count is
 * computed server-side from the same pending resolver the CSV export uses —
 * sheet-wide and ack-aware, so the button can never disagree with the export.
 */
export function MarkCollectedButton({
  spreadsheetId,
  runId,
  isBaseline,
  unenteredCount,
}: {
  spreadsheetId: string;
  runId: string;
  isBaseline: boolean;
  unenteredCount: number;
}) {
  const [open, setOpen] = useState(false);

  const label = isBaseline ? (
    <>
      <CheckCircle2 className="size-4 text-diff-move-fg" /> Collected here
    </>
  ) : (
    <>
      <Star className="size-4" /> Mark as collected
      {/* "since collection" anchors the number: it counts the pending window
          (last collection -> latest), not whatever pair the diff view shows */}
      {unenteredCount > 0 ? ` (${unenteredCount} to enter since collection)` : ""}
    </>
  );

  if (isBaseline || unenteredCount === 0) {
    return (
      <form action={setBaseline}>
        <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
        <input type="hidden" name="runId" value={runId} />
        <Button type="submit" size="sm" variant={isBaseline ? "secondary" : "outline"}>
          {label}
        </Button>
      </form>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="outline">
            {label}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={setBaseline}>
          <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
          <input type="hidden" name="runId" value={runId} />
          <DialogHeader>
            <DialogTitle>Mark as collected with {unenteredCount} change{unenteredCount === 1 ? "" : "s"} unentered?</DialogTitle>
            <DialogDescription>
              Everything changed since the current collection point will be considered entered —
              including {unenteredCount === 1 ? "this change" : "these changes"} on tabs you may not
              be viewing. Download the typing list first (More options → Typing list) if InEight still needs {unenteredCount === 1 ? "it" : "them"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Yes, everything is entered</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
