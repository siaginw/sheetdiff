"use client";

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
import { Textarea } from "@/components/ui/textarea";
import { addNote } from "@/lib/actions";
import { MessageSquarePlus, MessageSquareText, Trash2 } from "lucide-react";
import { useState } from "react";

/** Attach an audit note ("why this changed") to a snapshot run or a row. */
export function NoteDialog({
  spreadsheetId,
  runId,
  tabId,
  rowKey,
  existingNote,
  label,
  variant = "ghost",
}: {
  spreadsheetId: string;
  runId?: string;
  tabId?: string;
  rowKey?: string;
  existingNote?: string;
  label?: string;
  variant?: "ghost" | "outline";
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(existingNote ?? "");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          label ? (
            <Button type="button" variant={variant} size="sm">
              {existingNote ? <MessageSquareText className="size-4" /> : <MessageSquarePlus className="size-4" />}
              {label}
            </Button>
          ) : (
            <button
              type="button"
              aria-label={existingNote ? "Edit note" : "Add note"}
              title={existingNote ? `Note: ${existingNote}` : "Add note"}
              className={`rounded-md p-2 transition-colors ${
                existingNote ? "text-diff-move-fg" : "text-muted-foreground/50 hover:bg-muted hover:text-foreground"
              }`}
            >
              {existingNote ? <MessageSquareText className="size-3.5" /> : <MessageSquarePlus className="size-3.5" />}
            </button>
          )
        }
      />
      <DialogContent className="sm:max-w-md">
        <form
          action={addNote}
          onSubmit={(e) => {
            // Delete submits with the old text still in the textarea — drop the
            // stale body so reopening the dialog doesn't resurrect the note
            const submitter = (e.nativeEvent as SubmitEvent).submitter;
            if (submitter instanceof HTMLButtonElement && submitter.name === "delete") setBody("");
            setOpen(false);
          }}
        >
          <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
          {runId ? <input type="hidden" name="runId" value={runId} /> : null}
          {tabId ? <input type="hidden" name="tabId" value={tabId} /> : null}
          {rowKey ? <input type="hidden" name="rowKey" value={rowKey} /> : null}
          <DialogHeader>
            <DialogTitle>Audit note</DialogTitle>
            <DialogDescription>
              The &ldquo;why&rdquo; behind the change — shown next to the diff and in the daily digest, so whoever
              collects the data doesn&rsquo;t need to ask.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3">
            <Label htmlFor="note-body" className="sr-only">
              Note
            </Label>
            <Textarea
              id="note-body"
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="e.g. Ending station was entered wrong — GIS has 15743, creates a 2 ft gap."
              rows={4}
              autoFocus
            />
          </div>
          <DialogFooter className="flex items-center gap-2">
            {existingNote ? (
              <Button
                type="submit"
                name="delete"
                value="1"
                variant="outline"
                className="text-destructive"
                title="Remove this note"
              >
                <Trash2 className="size-4" /> Delete
              </Button>
            ) : null}
            <Button type="submit" disabled={!body.trim()}>
              Save note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
