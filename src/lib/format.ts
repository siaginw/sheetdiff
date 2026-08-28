import type { Spreadsheet } from "./db/schema";

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function scheduleLabel(sheet: Pick<Spreadsheet, "scheduleKind" | "scheduleHours" | "scheduleTime" | "scheduleDay">): string {
  switch (sheet.scheduleKind) {
    case "hourly":
      return `Every ${sheet.scheduleHours ?? 1}h`;
    case "daily":
      return `Daily ${formatTime(sheet.scheduleTime)}`;
    case "weekly":
      return `${DAY_NAMES[sheet.scheduleDay ?? 1]}s ${formatTime(sheet.scheduleTime)}`;
    default:
      return "Manual only";
  }
}

function formatTime(t: string | null): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? "");
  if (!m) return t ?? "";
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]));
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
