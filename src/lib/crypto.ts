import crypto from "node:crypto";

/**
 * Key derivation + AEAD + signed payloads.
 *
 * Two independent subkeys are derived from APP_SECRET with distinct labels so
 * the token-encryption key and the session-signing key never share bytes, and
 * sessions carry an expiry that verifySigned enforces.
 */

/** Values that must never act as the signing/encryption secret — they ship
 *  verbatim in the public repo's .env.example, so accepting one means anyone
 *  holding the public repo can forge session cookies and decrypt the stored
 *  Google tokens at rest. */
const PLACEHOLDER_SECRETS = new Set([
  "change-me-to-a-long-random-string",
  "your-app-secret",
  "replace-me",
]);

function deriveKey(purpose: "enc" | "sig"): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16 || PLACEHOLDER_SECRETS.has(secret)) {
    throw new Error(
      "APP_SECRET is missing, too short, or a known placeholder (the .env.example value is public — " +
        "anyone could forge sessions with it). Run `npm run setup` to generate a .env file, " +
        "or set APP_SECRET to a random string (e.g. `openssl rand -hex 32`).",
    );
  }
  return crypto.scryptSync(secret, `sheetdiff-${purpose}-v2`, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024, // 128*N*r ≈ 32 MB + overhead exceeds Node's 32 MB default cap
  });
}

const encKeyCache = new Map<string, Buffer>();
function key(purpose: "enc" | "sig"): Buffer {
  // cached per-process; scrypt at raised cost is ~100ms and only paid once
  let k = encKeyCache.get(purpose);
  if (!k) {
    k = deriveKey(purpose);
    encKeyCache.set(purpose, k);
  }
  return k;
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key("enc"), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptJson<T>(payload: string): T {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key("enc"), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/** Signed payload `${data}.${exp}.${hmac}`; exp=0 means no expiry. */
export function signValue(data: string, ttlMs = 0): string {
  const exp = ttlMs > 0 ? Date.now() + ttlMs : 0;
  const body = `${data}.${exp}`;
  const mac = crypto.createHmac("sha256", key("sig")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySigned(value: string | undefined | null): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [data, expStr, given] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return null;
  if (exp > 0 && Date.now() > exp) return null; // expired
  const body = `${data}.${expStr}`;
  const expected = crypto.createHmac("sha256", key("sig")).update(body).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return data;
}
