/**
 * REAL HTTP-PATH tests for the Google client — MSW intercepts the wire so
 * these exercise the actual googleapis code (batchGet chunking, range
 * quoting, the response-ORDERING guard) instead of a module mock that
 * bypasses it all.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const seenRequests: { url: string; body: unknown }[] = [];

const handlers = [
  http.post("https://oauth2.googleapis.com/token", () =>
    HttpResponse.json({ access_token: "test-access", expires_in: 3600, token_type: "Bearer" }),
  ),
  http.get("https://sheets.googleapis.com/v4/spreadsheets/:id/values/:range", ({ request }) => {
    seenRequests.push({ url: request.url, body: null });
    return HttpResponse.json({
      values: [
        ["A", "B"],
        ["1", "2"],
      ],
    });
  }),
  http.get("https://sheets.googleapis.com/v4/spreadsheets/:id/values:batchGet", ({ request }) => {
    const url = new URL(request.url);
    const ranges = url.searchParams.getAll("ranges");
    seenRequests.push({ url: request.url, body: ranges });
    // echo each range back in order — the guard under test verifies pairing
    return HttpResponse.json({
      valueRanges: ranges.map((r) => ({ range: r, values: [[r]] })),
    });
  }),
];

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  seenRequests.length = 0;
});
afterAll(() => server.close());

// google.ts reads credentials from env at import time in tests — construct
// the client through the module's own path with a fake stored token set
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { fetchTabValues, createOAuthClient } = await import("./google");

function fakeClient() {
  // an already-authenticated OAuth2 client (the token endpoint above
  // satisfies any refresh attempt)
  const client = createOAuthClient();
  client.setCredentials({
    refresh_token: "r",
    access_token: "a",
    expiry_date: Date.now() + 3_600_000,
  });
  return client;
}

describe("google client over the real HTTP path (MSW)", () => {
  it("quotes tab names with spaces/specials into legal ranges", async () => {
    await fetchTabValues(fakeClient(), "sid", ["Line List", "PE-1"]);
    const urls = seenRequests.map((r) => r.url);
    const decoded = urls.map(decodeURIComponent);
    expect(decoded.some((u) => u.includes("'Line List'"))).toBe(true);
    expect(decoded.some((u) => u.includes("'PE-1'"))).toBe(true);
  });

  it("chunks more than 10 tabs into multiple batchGet calls", async () => {
    const titles = Array.from({ length: 23 }, (_, i) => `T${i}`);
    await fetchTabValues(fakeClient(), "sid", titles);
    const batchCalls = seenRequests.filter((r) => r.url.includes("batchGet"));
    expect(batchCalls).toHaveLength(3); // 10 + 10 + 3
  });

  it("pairs each response with the tab that requested it, in order", async () => {
    const out = await fetchTabValues(fakeClient(), "sid", ["Alpha", "Beta"]);
    expect(out["Alpha"]).toEqual([["'Alpha'"]]);
    expect(out["Beta"]).toEqual([["'Beta'"]]);
  });

  it("ABORTS when Google returns ranges out of order — never stores one tab's rows under another", async () => {
    server.use(
      http.get("https://sheets.googleapis.com/v4/spreadsheets/:id/values:batchGet", ({ request }) => {
        const ranges = new URL(request.url).searchParams.getAll("ranges");
        const flipped = [...ranges].reverse();
        return HttpResponse.json({
          valueRanges: flipped.map((r) => ({ range: r, values: [[r]] })),
        });
      }),
    );
    await expect(fetchTabValues(fakeClient(), "sid", ["Alpha", "Beta"])).rejects.toThrow(/out of order/i);
  });

  it("empty grids (a valueRange with no values field) map to empty grids, not undefined", async () => {
    server.use(
      http.get("https://sheets.googleapis.com/v4/spreadsheets/:id/values:batchGet", ({ request }) => {
        const ranges = new URL(request.url).searchParams.getAll("ranges");
        return HttpResponse.json({ valueRanges: ranges.map((r) => ({ range: r })) });
      }),
    );
    const out = await fetchTabValues(fakeClient(), "sid", ["Alpha", "Beta"]);
    expect(out["Alpha"]).toEqual([]);
    expect(out["Beta"]).toEqual([]);
  });
});
