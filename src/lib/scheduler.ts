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
  if (ticking) return; // a slow Google fetch must not double-capture
  ticking = true;
  try {
    await tickInner();
    // dead-man switch: this only fires while the process AND scheduler live
    const ping = process.env.HEALTHCHECK_PING_URL;
    if (ping) await fetch(ping, { method: "POST" }).catch(() => {});
  } finally {
    ticking = false;
  }
}

let ticking = false;

async function tickInner() {
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
      // A null bump (unparsable schedule) must ALSO move nextRunAt — otherwise
      // the stale due time retries every minute forever.
      const bumped = computeNextRun(sheet, now) ?? now + 6 * 3_600_000;
      await db.update(spreadsheets).set({ nextRunAt: bumped }).where(eq(spreadsheets.id, sheet.id));
    }
  }

  // daily digest emails + maintenance (retention/backup)
  try {
    const { usersDueForDigest, sendDigestTo } = await import("./digest");
    const { db: ddb } = await import("./db");
    const { users } = await import("./db/schema");
    const dueUsers = await usersDueForDigest(now);
    for (const u of dueUsers) {
      try {
        const result = await sendDigestTo(u);
        // bump the cooldown for any completed evaluation — otherwise users with
        // nothing to send get re-evaluated every single minute
        if (result.sent || result.reason === "smtp-not-configured" || result.reason === "no-email" || result.reason === "no-sheets") {
          await ddb.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id));
        }
        if (result.sent) {
          console.log(`[scheduler] digest sent (user ${u.id})`);
        } else if (result.reason === "smtp-not-configured") {
          console.warn("[scheduler] digest skipped: SMTP_HOST/SMTP_USER/SMTP_PASS not configured");
        }
      } catch (err) {
        console.error(`[scheduler] digest for user ${u.id} failed:`, err instanceof Error ? err.message : err);
      }
    }

    const { maintenanceDue, runMaintenance } = await import("./maintenance");
    if (maintenanceDue(new Date(now))) await runMaintenance();
  } catch (err) {
    console.error("[scheduler] digest/maintenance pass failed:", err);
  }
}
