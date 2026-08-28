import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for Google refresh tokens at rest.
 * The key is derived from APP_SECRET, which must be set in .env.
 */

function deriveKey(): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "APP_SECRET is missing or too short. Run `npm run setup` to generate a .env file, " +
        "or set APP_SECRET to a random string (e.g. `openssl rand -hex 32`).",
    );
  }
  return crypto.scryptSync(secret, "sheetdiff-token-encryption", 32);
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptJson<T>(payload: string): T {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/** Signed session value: `${data}.${hmac}` */
export function signValue(data: string): string {
  const mac = crypto.createHmac("sha256", deriveKey()).update(data).digest("base64url");
  return `${data}.${mac}`;
}

export function verifySigned(value: string | undefined | null): string | null {
  if (!value) return null;
  const idx = value.lastIndexOf(".");
  if (idx === -1) return null;
  const data = value.slice(0, idx);
  const expected = crypto.createHmac("sha256", deriveKey()).update(data).digest("base64url");
  const given = value.slice(idx + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return data;
}
