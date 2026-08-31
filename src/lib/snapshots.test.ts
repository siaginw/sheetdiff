/** computeNextRun boundary table — pure logic, googleapis mocked away. */
import { vi } from "vitest";
vi.mock("./google", () => ({ getUserClient: vi.fn(), fetchTabValues: vi.fn() }));
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), "sd-test-")), "unused.db");

import { describe, it, expect } from "vitest";
import { computeNextRun } from "./snapshots";
import type { Spreadsheet } from "./db/schema";

const DAY = 86_400_000;
const at = (iso: string, h: number, m: number) => {
  const d = new Date(iso);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

type Sched = Partial<Spreadsheet>;
const sheet = (s: Sched): Spreadsheet => ({
  id: "x",
  userId: "u",
  googleId: "g",
  title: "t",
  url: "https://x",
  scheduleKind: "off",
  scheduleHours: null,
  scheduleTime: null,
  scheduleDay: null,
  nextRunAt: null,
  lastSnapshotAt: null,
  captureFailStreak: 0,
  lastCaptureError: null,
  lastCaptureErrorAt: null,
  createdAt: 0,
  ...s,
});

describe("computeNextRun", () => {
  it.each([
    ["daily, time passed today → tomorrow", "2026-08-29T18:00:00", { scheduleKind: "daily", scheduleTime: "09:00" }, at("2026-08-29T18:00:00", 9, 0) + DAY],
    ["daily, time still ahead → today", "2026-08-29T08:00:00", { scheduleKind: "daily", scheduleTime: "09:00" }, at("2026-08-29T08:00:00", 9, 0)],
    ["daily, exactly at boundary → tomorrow", "2026-08-29T09:00:00", { scheduleKind: "daily", scheduleTime: "09:00" }, at("2026-08-29T09:00:00", 9, 0) + DAY],
    ["weekly Sat → next Mon", "2026-08-29T18:00:00", { scheduleKind: "weekly", scheduleTime: "09:00", scheduleDay: 1 }, at("2026-08-29T18:00:00", 9, 0) + 2 * DAY],
    ["weekly same-day passed → +7", "2026-08-31T18:00:00", { scheduleKind: "weekly", scheduleTime: "09:00", scheduleDay: 1 }, at("2026-08-31T18:00:00", 9, 0) + 7 * DAY],
    ["weekly same-day ahead → today", "2026-08-31T07:00:00", { scheduleKind: "weekly", scheduleTime: "09:00", scheduleDay: 1 }, at("2026-08-31T07:00:00", 9, 0)],
  ])("%s", (_name, from, sched, expected) => {
    expect(computeNextRun(sheet(sched as Sched), new Date(from as string).getTime())).toBe(expected);
  });

  it("hourly adds N hours; off/bad-time → null", () => {
    expect(computeNextRun(sheet({ scheduleKind: "hourly", scheduleHours: 3 }), 1000)).toBe(1000 + 3 * 3_600_000);
    expect(computeNextRun(sheet({}), 1000)).toBeNull();
    expect(computeNextRun(sheet({ scheduleKind: "daily", scheduleTime: "9am" }), 1000)).toBeNull();
  });
});
