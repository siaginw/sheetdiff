"use client";

import { useState } from "react";
import { UserPlus, X } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { addMembers, removeMember } from "@/lib/actions";

/** Manage viewer access: members sign in with their own Google account
 *  (matched by email) and can see diffs, leave notes, tick off changes,
 *  and mark collections — nothing destructive. */
export function ShareDialog({ members }: { members: { id: string; email: string }[] }) {
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <DropdownMenuItem onSelect={undefined} onClick={() => setOpen(true)}>
            <UserPlus /> Share access…
          </DropdownMenuItem>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share access</DialogTitle>
          <DialogDescription>
            Add teammates by email. When they sign in with that Google account they can see your
            sheets, read diffs and notes, tick changes off as entered, and mark collections —
            they can&rsquo;t delete sheets, change schedules, or touch your settings.
          </DialogDescription>
        </DialogHeader>

        {members.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="truncate font-mono text-xs">{m.email}</span>
                <form action={removeMember}>
                  <input type="hidden" name="id" value={m.id} />
                  <button
                    type="submit"
                    aria-label={`Remove ${m.email}`}
                    className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="size-4" />
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            Not shared with anyone yet.
          </p>
        )}

        <form action={addMembers} onSubmit={() => setEmails("")} className="grid gap-2">
          <Label htmlFor="share-emails">Add people</Label>
          <Input
            id="share-emails"
            name="emails"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="erin@company.com, randy@company.com"
          />
          <DialogFooter className="mt-1">
            <Button type="submit" disabled={!emails.trim()}>
              Grant access
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
