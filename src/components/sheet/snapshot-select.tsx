"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

export interface SnapshotOption {
  id: string;
  label: string;
}

/**
 * From/To snapshot pickers. Navigation-based so the whole page (diff, chips,
 * timeline) re-renders from fresh server data on every change.
 */
export function SnapshotSelect({
  spreadsheetId,
  tabParam,
  options,
  from,
  to,
}: {
  spreadsheetId: string;
  tabParam: string;
  options: SnapshotOption[];
  from: string;
  to: string;
}) {
  const router = useRouter();

  const navigate = (nextFrom: string, nextTo: string) => {
    const params = new URLSearchParams();
    if (tabParam) params.set("tab", tabParam);
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    router.push(`/sheets/${spreadsheetId}?${params.toString()}`);
  };

  const trigger = (
    value: string,
    triggerOptions: { value: string; label: string }[],
    onChange: (v: string) => void,
    aria: string,
    keyPrefix: string,
  ) => (
    <Select
      key={keyPrefix}
      items={triggerOptions}
      value={value}
      onValueChange={(v) => {
        if (typeof v === "string") onChange(v);
      }}
    >
      <SelectTrigger aria-label={aria} className="h-8 min-w-36 flex-1 text-xs sm:w-52 sm:flex-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {triggerOptions.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // a snapshot can't be compared with itself — hide it from the opposite list
  const fromItems = options.filter((o) => o.id !== to).map((o) => ({ value: o.id, label: o.label }));
  const toItems = options.filter((o) => o.id !== from).map((o) => ({ value: o.id, label: o.label }));

  return (
    // wraps on phones: two fixed 13rem triggers + labels measured 539px inside
    // a 390px viewport and panned the whole page sideways
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
      <span className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">before</span>
        {trigger(from, fromItems, (v) => navigate(v, to), "Compare from snapshot", "from")}
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 items-center gap-1.5">
        {trigger(to, toItems, (v) => navigate(from, v), "Compare to snapshot", "to")}
        <span className="shrink-0 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">after</span>
      </span>
    </div>
  );
}
