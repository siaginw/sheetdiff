"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { updateSchedule } from "@/lib/actions";
import type { Spreadsheet } from "@/lib/db/schema";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const KIND_ITEMS = [
  { value: "off", label: "Off — manual only" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/**
 * Snapshot schedule editor: off / every N hours / daily at a time / weekly on
 * a weekday + time. One form posting to the updateSchedule server action.
 */
export function ScheduleDialog({ sheet }: { sheet: Spreadsheet }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(sheet.scheduleKind);
  const [hours, setHours] = useState(String(sheet.scheduleHours ?? 1));
  const [time, setTime] = useState(sheet.scheduleTime ?? "09:00");
  const [day, setDay] = useState(String(sheet.scheduleDay ?? 1));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <CalendarClock className="size-4" /> Schedule
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={updateSchedule} onSubmit={() => setOpen(false)}>
          <input type="hidden" name="spreadsheetId" value={sheet.id} />
          <input type="hidden" name="kind" value={kind} />
          {kind === "hourly" ? <input type="hidden" name="hours" value={hours} /> : null}
          {kind === "daily" || kind === "weekly" ? <input type="hidden" name="time" value={time} /> : null}
          {kind === "weekly" ? <input type="hidden" name="day" value={day} /> : null}

          <DialogHeader>
            <DialogTitle>Snapshot schedule</DialogTitle>
            <DialogDescription>
              Automatic snapshots run while the SheetDiff app is running.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-right text-sm">Repeat</Label>
              <Select
                items={KIND_ITEMS}
                value={kind}
                onValueChange={(v) => {
                  if (v !== null) setKind(v as typeof kind);
                }}
              >
                <SelectTrigger className="col-span-3">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off — manual only</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {kind === "hourly" ? (
              <div className="grid grid-cols-4 items-center gap-2">
                <Label className="text-right text-sm">Every</Label>
                <Select
                  items={[1, 2, 3, 6, 12].map((h) => ({ value: String(h), label: `${h} ${h === 1 ? "hour" : "hours"}` }))}
                  value={hours}
                  onValueChange={(v) => {
                    if (typeof v === "string") setHours(v);
                  }}
                >
                  <SelectTrigger className="col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["1", "2", "3", "6", "12"].map((h) => (
                      <SelectItem key={h} value={h}>
                        {h} {h === "1" ? "hour" : "hours"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {kind === "daily" || kind === "weekly" ? (
              <div className="grid grid-cols-4 items-center gap-2">
                <Label htmlFor="sched-time" className="text-right text-sm">At</Label>
                <Input
                  id="sched-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="col-span-3"
                />
              </div>
            ) : null}

            {kind === "weekly" ? (
              <div className="grid grid-cols-4 items-center gap-2">
                <Label className="text-right text-sm">On</Label>
                <Select
                  items={DAYS.map((d, i) => ({ value: String(i), label: d }))}
                  value={day}
                  onValueChange={(v) => {
                    if (typeof v === "string") setDay(v);
                  }}
                >
                  <SelectTrigger className="col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="submit">Save schedule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
