"use server";

import { getSessionUser } from "./session";
import { sendDigestTo, type DigestSkipReason } from "./digest";

/** Fire the digest to the configured address right now, so SMTP setup can be
 *  validated immediately instead of waiting for the scheduled send. */
export async function sendTestDigest(): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Not signed in" };
  if (!user.digestEmail) return { ok: false, error: "Set a recipient address first" };
  try {
    const result = await sendDigestTo(user);
    if (result.sent) return { ok: true };
    const reasons: Record<DigestSkipReason, string> = {
      "smtp-not-configured": "Email sending isn't configured on this server (SMTP_HOST / SMTP_USER / SMTP_PASS)",
      "no-email": "No recipient address",
      "no-sheets": "No accessible sheets to report on",
    };
    return { ok: false, error: reasons[result.reason] };
  } catch (err) {
    // SMTP errors embed hostnames/credentials — never surface them to clients
    console.error("[digest] test send failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Sending failed — check the server logs (SMTP host, port, and app password)." };
  }
}
