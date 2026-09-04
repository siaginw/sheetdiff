import { logger } from "./logger";

/**
 * Push notifications via ntfy (github.com/binwiederhier/ntfy) — the user
 * subscribes to a topic URL on their phone (ntfy.sh app or self-hosted
 * server) and puts that URL in Settings. A capture that introduces changes
 * then buzzes their pocket in seconds — the email digest stays for the daily
 * summary; this is the "something changed RIGHT NOW" lane.
 *
 * Rules: never blocks or fails a capture (5s timeout, errors logged and
 * swallowed), never sends for quiet captures, and the URL is validated
 * before it's ever stored.
 */

export function isValidNotifyUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && u.pathname.replace(/\/+$/, "") !== "";
  } catch {
    return false;
  }
}

export async function sendPush(
  url: string,
  payload: { title: string; message: string; click?: string; tag?: string },
): Promise<boolean> {
  if (!isValidNotifyUrl(url)) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        message: payload.message,
        ...(payload.click ? { click: payload.click } : {}),
        ...(payload.tag ? { tags: payload.tag } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[notify] push rejected");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "[notify] push failed");
    return false;
  }
}

/** Notify the sheet's owner that this capture introduced work to enter. */
export async function notifyCaptureChanges(input: {
  notifyUrl: string;
  sheetTitle: string;
  sheetId: string;
  changes: number;
  isBaselineFirstCapture: boolean;
}): Promise<void> {
  if (input.notifyUrl === "" || input.changes <= 0 || input.isBaselineFirstCapture) return;
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  await sendPush(input.notifyUrl, {
    title: input.sheetTitle,
    message: `${input.changes} new change${input.changes === 1 ? "" : "s"} to enter in the office system`,
    click: `${appUrl}/sheets/${input.sheetId}`,
    tag: "pencil",
  });
}
