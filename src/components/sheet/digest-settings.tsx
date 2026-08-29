"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
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
import { saveDigestSettings } from "@/lib/actions";

/** Daily digest email settings (address + send time). */
export function DigestSettingsDialog({
  digestEmail,
  digestTime,
}: {
  digestEmail: string | null;
  digestTime: string;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(digestEmail ?? "");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <DropdownMenuItem onSelect={undefined} onClick={() => setOpen(true)}>
            <Mail /> Daily digest…
          </DropdownMenuItem>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={saveDigestSettings} onSubmit={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>Daily digest email</DialogTitle>
            <DialogDescription>
              Each morning: what changed since the last collection, unresolved changes, check
              findings, and audit notes — the email version of the dashboard. Requires SMTP
              settings in .env (see README). Clear the address to turn it off.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-5 items-center gap-2">
              <Label htmlFor="digest-email" className="col-span-1 text-right text-sm">To</Label>
              <Input
                id="digest-email"
                name="digestEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="erin@company.com"
                className="col-span-4"
              />
            </div>
            <div className="grid grid-cols-5 items-center gap-2">
              <Label htmlFor="digest-time" className="col-span-1 text-right text-sm">At</Label>
              <Input
                id="digest-time"
                name="digestTime"
                type="time"
                defaultValue={digestTime}
                className="col-span-4"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
