import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "./db";
import { spreadsheets, type Spreadsheet } from "./db/schema";
import { captureSnapshot, computeNextRun } from "./snapshots";

/**
 * In-process snapshot scheduler. Runs while the app runs (dev server or
 * `npm start`) and fires due snapshots once a minute.
 */

const TICK_MS = 60_000;

const globalForScheduler = globalThis as unknown as { __sheetdiffScheduler?: NodeJS.Timeout };

export function startScheduler() {
  if (globalForScheduler.__sheetdiffScheduler) return;
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  globalForScheduler.__sheetdiffScheduler = timer;
  console.log("[scheduler] started (checking every minute)");
  void tick();
}

async function loadDue(now: number): Promise<Spreadsheet[]> {
  return db
    .select()
    .from(spreadsheets)
    .where(
      and(
        ne(spreadsheets.scheduleKind, "off"),
        isNotNull(spreadsheets.nextRunAt),
        lte(spreadsheets.nextRunAt, now),
      ),
    );
}

async function tick() {
  const now = Date.now();
  let due: Spreadsheet[] = [];
  try {
    due = await loadDue(now);
  } catch (err) {
    console.error("[scheduler] failed to query due sheets:", err);
    return;
  }
  for (const sheet of due) {
    try {
      const result = await captureSnapshot(sheet.id, "scheduled");
      console.log(
        `[scheduler] snapshot of "${sheet.title}": ${result.tabCount} tab(s), ${result.rowCount} rows`,
      );
    } catch (err) {
      console.error(
        `[scheduler] snapshot of "${sheet.title}" failed:`,
        err instanceof Error ? err.message : err,
      );
      // Push the next attempt forward so a broken sheet can't loop every minute.
      const bumped = computeNextRun(sheet, now);
      if (bumped !== null) {
        await db.update(spreadsheets).set({ nextRunAt: bumped }).where(eq(spreadsheets.id, sheet.id));
      }
    }
  }

  // daily digest emails
  try {
    const { usersDueForDigest, sendDigestTo } = await import("./digest");
    const { db: ddb } = await import("./db");
    const { users } = await import("./db/schema");
    const dueUsers = await usersDueForDigest(now);
    for (const u of dueUsers) {
      try {
        const result = await sendDigestTo(u);
        if (result.sent) {
          await ddb.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id));
          console.log(`[scheduler] digest sent to ${u.digestEmail}`);
        } else if (result.reason === "smtp-not-configured") {
          // avoid re-checking every minute
          await ddb.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id));
          console.warn("[scheduler] digest skipped: SMTP_HOST/SMTP_USER/SMTP_PASS not configured");
        }
      } catch (err) {
        console.error(`[scheduler] digest for ${u.digestEmail} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[scheduler] digest pass failed:", err);
  }
}
