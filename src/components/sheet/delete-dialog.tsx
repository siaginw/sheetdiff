"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { removeSheet } from "@/lib/actions";

export function DeleteSheetDialog({
  spreadsheetId,
  title,
}: {
  spreadsheetId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        // the trigger renders a DropdownMenuItem (not a native <button>), so
        // Base UI's native-button assumptions must be off or the click never
        // opens the dialog
        nativeButton={false}
        render={
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => e.preventDefault()} // keep the menu open while the dialog opens
          >
            <Trash2 /> Stop tracking…
          </DropdownMenuItem>
        }
      />
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
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
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
