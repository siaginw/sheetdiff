/** Crypto round-trips — pure, no DB. APP_SECRET set before any import. */
process.env.APP_SECRET ??= "unit-test-secret-0123456789abcdef";

import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptJson, encryptJson, signValue, verifySigned } from "./crypto";

describe("signValue / verifySigned", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips and rejects tampering and malformed input", () => {
    const t = signValue("user-1", 60_000);
    expect(verifySigned(t)).toBe("user-1");
    expect(verifySigned(t.slice(0, -2) + "zz")).toBeNull();
    expect(verifySigned("a.b")).toBeNull();
    expect(verifySigned(undefined)).toBeNull();
    expect(verifySigned(null)).toBeNull();
  });

  it("honors expiry (ttl > 0) and treats 0 as no-expiry", () => {
    const short = signValue("u", 60_000);
    vi.setSystemTime(Date.now() + 61_000);
    expect(verifySigned(short)).toBeNull();
    vi.useRealTimers();
    expect(verifySigned(signValue("u", 0))).toBe("u");
  });
});

describe("AES-256-GCM round-trip", () => {
  it("encrypts and decrypts tokens", () => {
    const token = { refresh_token: "r", access_token: "a", expiry_date: 123 };
    const enc = encryptJson(token);
    expect(enc).not.toContain("refresh_token");
    expect(decryptJson<typeof token>(enc)).toEqual(token);
  });

  it("refuses garbage ciphertext", () => {
    expect(() => decryptJson("!!!")).toThrow();
  });
});

describe("placeholder APP_SECRET rejection", () => {
  // module-level key cache: each check needs a FRESH module with the env set
  // before import
  async function withSecret(secret: string | undefined): Promise<unknown> {
    vi.resetModules();
    if (secret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = secret;
    const mod = await import("./crypto");
    try {
      mod.encryptJson({ x: 1 });
      return null;
    } catch (err) {
      return err;
    }
  }

  it("rejects every public .env.example value (anyone holding the repo could forge sessions)", async () => {
    for (const bad of [
      "change-me-to-a-long-random-string",
      "your-app-secret",
      "replace-me",
      "your-client-secret",
      "your-client-id.apps.googleusercontent.com",
      "your-app-password",
    ]) {
      const err = (await withSecret(bad)) as Error | null;
      expect(err, `placeholder must be rejected: ${bad}`).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/APP_SECRET/);
    }
  });

  it("rejects whitespace-padded placeholders and too-short values", async () => {
    expect(await withSecret("  change-me-to-a-long-random-string  ")).toBeInstanceOf(Error);
    expect(await withSecret("short")).toBeInstanceOf(Error);
    expect(await withSecret(undefined)).toBeInstanceOf(Error);
  });

  it("accepts a real random secret (round-trips)", async () => {
    const err = await withSecret("a-real-random-secret-0123456789abcdef");
    expect(err).toBeNull();
  });
});
