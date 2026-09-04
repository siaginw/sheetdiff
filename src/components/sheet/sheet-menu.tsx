"use client";

import { DeleteSheetDialog } from "@/components/sheet/delete-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CalendarRange, Download, ExternalLink, MoreHorizontal, ReceiptText, Trash2 } from "lucide-react";
import { useState } from "react";

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
          <DropdownMenuItem render={<a href={`/sheets/${spreadsheetId}/export/queue`} />}>
            <Download /> Typing list — one row per entry (for the office system)
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`/sheets/${spreadsheetId}/report`} />}>
            <CalendarRange /> Weekly production report
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`/sheets/${spreadsheetId}/billing`} />}>
            <ReceiptText /> Billing day dashboard
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`/sheets/${spreadsheetId}/export`} />}>
            <Download /> Every edit, cell by cell (detailed CSV)
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={`/sheets/${spreadsheetId}/export/billing`} />}>
            <Download /> Billing-day summary (CSV)
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
        <DeleteSheetDialog open={deleteOpen} onOpenChange={setDeleteOpen} spreadsheetId={spreadsheetId} title={title} />
      ) : null}
    </>
  );
}
