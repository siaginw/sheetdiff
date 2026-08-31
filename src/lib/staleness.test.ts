import { describe, it, expect } from "vitest";
import { captureIsStale } from "./staleness";

/**
 * The ONE staleness rule behind the dashboard badge, the digest email, and
 * /api/health's staleCaptures — if these boundaries drift, the three surfaces
 * drift together, so the boundaries are pinned exactly.
 */
const NOW = 1_750_000_000_000;
type StaleSheet = Parameters<typeof captureIsStale>[0];
const sheet = (over: Partial<StaleSheet>): StaleSheet => ({
  scheduleKind: "hourly",
  scheduleHours: 1,
  lastSnapshotAt: NOW - 3_600_000,
  ...over,
});

describe("captureIsStale", () => {
  it("hourly: stale strictly AFTER 3x the window (one boundary, both sides)", () => {
    expect(captureIsStale(sheet({ lastSnapshotAt: NOW - 3 * 3_600_000 }), NOW)).toBe(false);
    expect(captureIsStale(sheet({ lastSnapshotAt: NOW - 3 * 3_600_000 - 1 }), NOW)).toBe(true);
  });

  it("hourly: scheduleHours scales the window", () => {
    expect(captureIsStale(sheet({ scheduleHours: 2, lastSnapshotAt: NOW - 6 * 3_600_000 }), NOW)).toBe(false);
    expect(captureIsStale(sheet({ scheduleHours: 2, lastSnapshotAt: NOW - 6 * 3_600_000 - 1 }), NOW)).toBe(true);
  });

  it("daily: 48h", () => {
    expect(captureIsStale(sheet({ scheduleKind: "daily", lastSnapshotAt: NOW - 48 * 3_600_000 }), NOW)).toBe(false);
    expect(captureIsStale(sheet({ scheduleKind: "daily", lastSnapshotAt: NOW - 48 * 3_600_000 - 1 }), NOW)).toBe(true);
  });

  it("weekly: 8d (one missed 7d run gets ~24h grace, not a flag)", () => {
    expect(captureIsStale(sheet({ scheduleKind: "weekly", lastSnapshotAt: NOW - 8 * 86_400_000 }), NOW)).toBe(false);
    expect(captureIsStale(sheet({ scheduleKind: "weekly", lastSnapshotAt: NOW - 8 * 86_400_000 - 1 }), NOW)).toBe(true);
  });

  it("paused sheets are never stale — not capturing is a choice", () => {
    expect(captureIsStale(sheet({ scheduleKind: "off", lastSnapshotAt: 1 }), NOW)).toBe(false);
  });

  it("never-captured sheets are never stale (nothing to be stale about)", () => {
    expect(captureIsStale(sheet({ lastSnapshotAt: null }), NOW)).toBe(false);
  });

  it("future timestamps (clock skew) are not stale", () => {
    expect(captureIsStale(sheet({ lastSnapshotAt: NOW + 86_400_000 }), NOW)).toBe(false);
  });

  it("null scheduleHours defaults the hourly window to 1h", () => {
    expect(captureIsStale(sheet({ scheduleHours: null, lastSnapshotAt: NOW - 3 * 3_600_000 - 1 }), NOW)).toBe(true);
  });
});
