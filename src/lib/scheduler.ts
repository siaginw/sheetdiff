import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "./db";
import { spreadsheets, type Spreadsheet } from "./db/schema";
import { logger } from "./logger";
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
  logger.info("[scheduler] started (checking every minute)");
  void tick();
}

async function loadDue(now: number): Promise<Spreadsheet[]> {
  return db
    .select()
    .from(spreadsheets)
    .where(
      and(ne(spreadsheets.scheduleKind, "off"), isNotNull(spreadsheets.nextRunAt), lte(spreadsheets.nextRunAt, now)),
    );
}

/** Dead-man semantics: ping only after a tick that captured something.
 *  Pure so the decision is pinnable — a dead OAuth token makes every capture
 *  fail while ticks succeed, and the monitor must go silent then. */
export function shouldPing(capturedSomething: boolean, url: string | undefined): boolean {
  return Boolean(url) && capturedSomething;
}

async function tick() {
  if (ticking) return; // a slow Google fetch must not double-capture
  ticking = true;
  try {
    const captured = await tickInner();
    // dead-man switch: pings while the process, scheduler, AND CAPTURES live.
    // Gating on capture success matters: a dead OAuth token makes every
    // capture fail while ticks succeed — the monitor would stay green while
    // the product silently starves (staleCaptures on /api/health is the
    // slower signal; this is the fast one).
    const ping = process.env.HEALTHCHECK_PING_URL;
    // bounded ping: a dead-man monitor that hangs (or slowly drips bytes)
    // must never pin `ticking` and stall every later capture
    if (ping && captured) await fetch(ping, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => {});
  } finally {
    ticking = false;
  }
}

let ticking = false;

async function tickInner(): Promise<boolean> {
  const now = Date.now();
  let due: Spreadsheet[] = [];
  try {
    due = await loadDue(now);
  } catch (err) {
    logger.error({ err }, "[scheduler] failed to query due sheets");
    return false;
  }
  let anySuccess = false;
  for (const sheet of due) {
    try {
      const result = await captureSnapshot(sheet.id, "scheduled");
      logger.info({ sheet: sheet.title, tabs: result.tabCount, rows: result.rowCount }, "[scheduler] snapshot");
      anySuccess = true;
    } catch (err) {
      logger.error(
        { sheet: sheet.title, err: err instanceof Error ? err.message : err },
        "[scheduler] snapshot failed",
      );
      // Push the next attempt forward so a broken sheet can't loop every minute.
      // A null bump (unparsable schedule) must ALSO move nextRunAt — otherwise
      // the stale due time retries every minute forever.
      const bumped = computeNextRun(sheet, now) ?? now + 6 * 3_600_000;
      await db.update(spreadsheets).set({ nextRunAt: bumped }).where(eq(spreadsheets.id, sheet.id));
      const { recordCaptureFailure } = await import("./snapshots");
      await recordCaptureFailure(sheet.id, err);
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
        // every completed evaluation (sent or skipped) bumps the cooldown —
        // otherwise empty-inbox users get re-evaluated every minute
        await ddb.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id));
        if (result.sent) {
          logger.info({ user: u.id }, "[scheduler] digest sent");
        } else if (result.reason === "smtp-not-configured") {
          logger.warn("[scheduler] digest skipped: SMTP_HOST/SMTP_USER/SMTP_PASS not configured");
        }
      } catch (err) {
        logger.error({ user: u.id, err: err instanceof Error ? err.message : err }, "[scheduler] digest failed");
      }
    }

    const { maintenanceDue, runMaintenance } = await import("./maintenance");
    if (maintenanceDue(new Date(now))) await runMaintenance();
  } catch (err) {
    logger.error({ err }, "[scheduler] digest/maintenance pass failed");
  }
  return anySuccess;
}
