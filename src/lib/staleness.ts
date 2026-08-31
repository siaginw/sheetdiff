import type { Spreadsheet } from "./db/schema";

/**
 * One rule for "captures have gone quiet", shared by the dashboard badge, the
 * digest email, and the health endpoint so they can never disagree:
 * 3x the hourly window, 48h for daily, 8d for weekly — enough consecutive
 * missed runs to be a real pipeline problem, not one hiccup.
 *
 * Paused sheets are never stale (not capturing by choice) — but see the
 * digest: paused sheets render "· paused" so "up to date" is never assumed
 * silently.
 */
export function captureIsStale(
  sheet: Pick<Spreadsheet, "scheduleKind" | "scheduleHours" | "lastSnapshotAt">,
  now = Date.now(),
): boolean {
  if (sheet.scheduleKind === "off" || !sheet.lastSnapshotAt) return false;
  const ageMs = now - sheet.lastSnapshotAt;
  const windowMs =
    sheet.scheduleKind === "hourly"
      ? (sheet.scheduleHours ?? 1) * 3_600_000 * 3
      : sheet.scheduleKind === "daily"
        ? 48 * 3_600_000
        : 8 * 24 * 3_600_000;
  return ageMs > windowMs;
}
