/** Crypto round-trips — pure, no DB. APP_SECRET set before any import. */
process.env.APP_SECRET ??= "unit-test-secret-0123456789abcdef";

import { describe, it, expect, vi, afterEach } from "vitest";
import { signValue, verifySigned, encryptJson, decryptJson } from "./crypto";

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
