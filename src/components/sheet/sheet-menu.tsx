"use client";

import { useState } from "react";
import { CalendarRange, Download, ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteSheetDialog } from "@/components/sheet/delete-dialog";

/**
 * The sheet page's "more options" menu + the delete dialog it launches.
 * Like AccountMenu, the dialog lives OUTSIDE the menu subtree — mounted
 * inside it, the dialog unmounts with the closing menu and never survives
 * the click (fleet-9 blocker).
 */
export function SheetMenu({
  spreadsheetId,
  title,
  sheetUrl,
  isOwner,
}: {
  spreadsheetId: string;
  title: string;
  sheetUrl: string;
  isOwner: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="icon-sm" aria-label="More options">
              <MoreHorizontal className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<a href={`${spreadsheetId}/export/queue`} />}>
            <Download /> Entry queue — one row per shot (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`${spreadsheetId}/report`} />}>
            <CalendarRange /> Weekly production report
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`${spreadsheetId}/export`} />}>
            <Download /> Changes to enter, cell by cell (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`${spreadsheetId}/export/billing`} />}>
            <Download /> Billing-day packet (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={sheetUrl} target="_blank" rel="noreferrer" />}>
            <ExternalLink /> Open in Google Sheets
          </DropdownMenuItem>
          {isOwner ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> Stop tracking…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {isOwner ? (
        <DeleteSheetDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          spreadsheetId={spreadsheetId}
          title={title}
        />
      ) : null}
    </>
  );
}
