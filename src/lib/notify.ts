import { lookup } from "node:dns/promises";
import net from "node:net";
import { logger } from "./logger";

/**
 * Push notifications via ntfy (github.com/binwiederhier/ntfy) — the user
 * subscribes to a topic URL on their phone/desktop and puts that URL in
 * Settings. A capture that introduces changes then buzzes their pocket in
 * seconds — the email digest stays for the daily summary; this is the
 * "something changed RIGHT NOW" lane.
 *
 * Rules: never blocks or fails a capture (callers fire-and-forget; errors
 * logged and swallowed), never sends for quiet captures, and the URL is a
 * SERVER-SIDE FETCH TARGET controlled by an end user — so it is treated as
 * hostile until proven otherwise:
 *
 *   - hostname is RESOLVED at send time and every resolved address is
 *     checked (loopback, link-local incl. cloud metadata, RFC1918, ULA,
 *     unspecified; IPv4-mapped IPv6 unwrapped) — validation at save time
 *     alone cannot stop DNS rebinding
 *   - redirects are refused (a public URL 302-ing into the LAN is a
 *     classic SSRF relay)
 *   - non-canonical IPv4 spellings (2130706433, 0x7f.1) die at resolution
 *
 * Set NOTIFY_ALLOW_PRIVATE_URLS=1 only if you deliberately run ntfy on the
 * same LAN as SheetDiff and trust every account that can sign in.
 */

export function isValidNotifyUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && u.pathname.replace(/\/+$/, "") !== "";
  } catch {
    return false;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
    if (a === 169 && b === 254) return true; // link-local — includes 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 — Tailscale & friends
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified, loopback
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
      return true; // link-local fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    // IPv4-mapped ::ffff:0:0/96 — the WHATWG URL parser canonicalizes the
    // dotted spelling to HEX ("[::ffff:127.0.0.1]" -> "::ffff:7f00:1"), so a
    // dotted-only regex never fires on URL-derived hostnames and every
    // guarded target was reachable via the hex spelling. Parse both forms;
    // anything in the mapped prefix is unwrapped and judged as IPv4, and an
    // UNPARSEABLE ::ffff: spelling is refused outright (hostile spelling).
    if (lower.startsWith("::ffff:")) {
      const tail = lower.slice("::ffff:".length);
      if (net.isIPv4(tail)) return isPrivateAddress(tail);
      const groups = tail.split(":").map((g) => parseInt(g || "0", 16));
      if (groups.length === 2 || groups.length === 4) {
        if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return true;
        const bytes: number[] = [];
        for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
        if (bytes.length === 4) return isPrivateAddress(bytes.join("."));
        // two groups = 32 bits: reject — a mapped address is exactly 32 bits
        // and two full groups spell a /96 we cannot interpret as IPv4
        const v4 = (groups[0]! << 16) | groups[1]!;
        return isPrivateAddress([v4 >>> 24, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff].join("."));
      }
      return true;
    }
    if (lower.startsWith("64:ff9b:")) return true; // NAT64 — translates to IPv4 we cannot inspect
    if (lower.startsWith("2002:")) return true; // 6to4 — embeds an arbitrary IPv4
    return false;
  }
  return true; // not an IP at all — treat as hostile
}

/**
 * Resolve the URL's hostname and refuse private targets. Returns null when
 * the URL is safe to fetch, or a human reason when it is not.
 */
export async function notifyUrlBlockReason(url: string): Promise<string | null> {
  if (process.env.NOTIFY_ALLOW_PRIVATE_URLS === "1") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "protocol";
  // https-only while the guard is active: the guard resolves, then fetch()
  // re-resolves independently — a rebinding DNS server can pass the check
  // with a public A record and answer the fetch's resolution privately.
  // Over https the rebound connection cannot complete TLS without a
  // hostname-valid certificate, which closes the window for the guarded
  // path. Plain http stays available via NOTIFY_ALLOW_PRIVATE_URLS=1 (LAN
  // ntfy), which returns above before this check.
  if (parsed.protocol !== "https:") return "http (https required unless NOTIFY_ALLOW_PRIVATE_URLS=1)";
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return isPrivateAddress(host) ? "private address" : null;
  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    return "DNS";
  }
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) return "private address";
  }
  return null;
}

export async function sendPush(
  url: string,
  payload: { title: string; message: string; click?: string; tag?: string },
): Promise<boolean> {
  if (!isValidNotifyUrl(url)) return false;
  const block = await notifyUrlBlockReason(url);
  if (block !== null) {
    logger.warn({ reason: block }, "[notify] push target refused (SSRF guard)");
    return false;
  }
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
      redirect: "error", // ntfy never legitimately redirects; a redirect into the LAN is an SSRF relay
      signal: AbortSignal.timeout(5_000),
    });
    // release the socket: an unconsumed body delays pooling and keeps the
    // connection (and its DNS answer) alive longer than it needs to be
    try {
      await res.body?.cancel();
    } catch {
      // body already gone — nothing to release
    }
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
}): Promise<void> {
  if (input.notifyUrl === "" || input.changes <= 0) return;
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  await sendPush(input.notifyUrl, {
    title: input.sheetTitle,
    message: `${input.changes} new change${input.changes === 1 ? "" : "s"} to enter in the office system`,
    click: `${appUrl}/sheets/${input.sheetId}`,
    tag: "pencil",
  });
}
