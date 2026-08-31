"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { removeSheet } from "@/lib/actions";

/** "Stop tracking" confirmation. Controlled: the sheet menu owns the open
 *  state so this dialog is never mounted inside the menu subtree (a dialog
 *  there unmounts with the closing menu — fleet 8/9's unreachable-delete
 *  bug class). */
export function DeleteSheetDialog({
  open,
  onOpenChange,
  spreadsheetId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spreadsheetId: string;
  title: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form action={removeSheet}>
          <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
          <DialogHeader>
            <DialogTitle>Stop tracking “{title}”?</DialogTitle>
            <DialogDescription>
              This deletes every snapshot SheetDiff has taken of it. The Google Sheet itself is
              never touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive">
              Delete snapshots
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
