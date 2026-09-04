/**
 * Add-sheet error taxonomy (Fleet-16 UX MED-2): `googleConfigured() === false`
 * is an ADMIN problem (env vars missing — a demo user can hit this signed in),
 * while a genuine read failure is a SHARING problem. One catch used to blur
 * them into "make sure the sheet is shared", sending the admin chasing Google
 * permissions instead of .env.
 *
 * Same harness contract as the report page test: temp DATABASE_PATH, signed
 * session cookie mocked, the page invoked as the async server component it is.
 */
import { vi } from "vitest";

const state = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const { signValue } = await import("@/lib/crypto");
    return {
      get: (name: string) =>
        name === "sd_session" && state.userId ? { value: signValue(state.userId, 30 * 24 * 3_600_000) } : undefined,
      delete: () => {},
    };
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/lib/actions", () => ({ startTracking: async () => {} }));

import { setupMigratedTempDb } from "@/test/db-harness";
import { beforeAll, describe, expect, it } from "vitest";

setupMigratedTempDb("add-sheet");

const { db } = await import("@/lib/db");
const { users } = await import("@/lib/db/schema");
const { default: NewSheetPage } = await import("./page");

const URL_PARAM = "https://docs.google.com/spreadsheets/d/1abcDefGHIjklMNOpqrsTUVwxyZ/edit";

function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out);
    return out;
  }
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) for (const v of Object.values(props)) textOf(v, out);
  }
  return out;
}

const render = (params: Record<string, string | string[]> = {}) =>
  NewSheetPage({ searchParams: Promise.resolve(params) });

beforeAll(async () => {
  // tokensEnc "x" is not decryptable — with Google configured, getUserClient
  // throws inside the page's try and lands in the genuine-read-error branch
  await db.insert(users).values({
    id: "owner",
    googleSub: "sub-owner",
    email: "owner@corp.com",
    name: "owner",
    tokensEnc: "x",
    createdAt: 1,
  });
});

describe("add-sheet error taxonomy", () => {
  it("unconfigured Google names the env vars for the admin — never blames sharing", async () => {
    state.userId = "owner";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const text = textOf(await render({ url: URL_PARAM }))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("GOOGLE_CLIENT_ID");
    expect(text).toContain("GOOGLE_CLIENT_SECRET");
    expect(text).not.toContain("shared with your Google account");
  });

  it("a genuine read failure still points at the link/share path", async () => {
    state.userId = "owner";
    process.env.GOOGLE_CLIENT_ID = "test-id.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const text = textOf(await render({ url: URL_PARAM }))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("shared with your Google account (Viewer is enough)");
    expect(text).not.toContain("GOOGLE_CLIENT_SECRET");
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it("a malformed URL keeps its own message regardless of configuration", async () => {
    state.userId = "owner";
    delete process.env.GOOGLE_CLIENT_ID;
    const text = textOf(await render({ url: "not-a-link" }))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("doesn't look like a Google Sheets link");
  });

  it("signed out redirects to login before any taxonomy applies", async () => {
    state.userId = null;
    await expect(render({ url: URL_PARAM })).rejects.toThrow("REDIRECT");
  });
});
