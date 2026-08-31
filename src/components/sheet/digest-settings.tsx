"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveDigestSettings } from "@/lib/actions";
import { sendTestDigest } from "@/lib/digest-actions";

const DAY_ITEMS = [
  { value: "daily", label: "Every day" },
  { value: "1", label: "Every Monday" },
  { value: "2", label: "Every Tuesday" },
  { value: "3", label: "Every Wednesday" },
  { value: "4", label: "Every Thursday" },
  { value: "5", label: "Every Friday" },
  { value: "6", label: "Every Saturday" },
  { value: "0", label: "Every Sunday" },
];

/** Daily/weekly digest email settings (address + cadence + send time).
 *  Controlled: the account menu owns the open state so this dialog is never
 *  mounted inside the menu subtree (it would unmount with the closing menu). */
export function DigestSettingsDialog({
  open,
  onOpenChange,
  digestEmail,
  digestTime,
  digestDay,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  digestEmail: string | null;
  digestTime: string;
  digestDay: number | null;
}) {
  const [email, setEmail] = useState(digestEmail ?? "");
  const [saved, setSaved] = useState(false);

  // server state can change between opens — re-sync rather than show a stale
  // address that looks configured
  const handleOpenChange = (next: boolean) => {
    if (next) setEmail(digestEmail ?? "");
    onOpenChange(next);
  };
  const [day, setDay] = useState(digestDay === null || digestDay === undefined ? "daily" : String(digestDay));
  const [testing, setTesting] = useState(false);

  const sendTest = () => {
    setTesting(true);
    void sendTestDigest()
      .then((r) => {
        if (r.ok) toast.success(`Test digest sent to ${email}`);
        else toast.error(`Test failed: ${r.error}`);
      })
      .finally(() => setTesting(false));
  };

  if (saved) {
    toast.success(
      email.trim() ? `Digest saved — ${email.trim()} will get ${day === "daily" ? "daily" : "weekly"} emails.` : "Digest turned off.",
    );
    setSaved(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          action={saveDigestSettings}
          onSubmit={() => {
            setSaved(true);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Digest email</DialogTitle>
            <DialogDescription>
              A scheduled email with what changed since the last collection, unresolved changes,
              check findings, footage movement, and audit notes. Requires SMTP settings in .env
              (see README). Clear the address to turn it off.
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
              <Label className="col-span-1 text-right text-sm">How often</Label>
              <input type="hidden" name="digestDay" value={day} />
              <Select
                items={DAY_ITEMS}
                value={day}
                onValueChange={(v) => {
                  if (typeof v === "string") setDay(v);
                }}
              >
                <SelectTrigger className="col-span-4">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_ITEMS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          <DialogFooter className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={sendTest}
              disabled={!email.trim() || testing}
            >
              <Send className="size-4" /> {testing ? "Sending…" : "Send test"}
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
