import { afterEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => dns);

const { notifyUrlBlockReason, sendPush } = await import("./notify");

afterEach(() => {
  dns.lookup.mockReset();
  delete process.env.NOTIFY_ALLOW_PRIVATE_URLS;
  vi.unstubAllGlobals();
});

describe("SSRF guard (resolve-at-send)", () => {
  it("refuses loopback, link-local (incl. cloud metadata), RFC1918, ULA, and unspecified targets", async () => {
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "172.16.5.5", family: 4 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "::1", family: 6 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "fe80::1", family: 6 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    dns.lookup.mockResolvedValue([{ address: "::", family: 6 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
  });

  it("checks EVERY resolved address (partial-private hostnames are refused)", async () => {
    dns.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(await notifyUrlBlockReason("https://dualstack.example/topic")).toBe("private address");
  });

  it("unwraps IPv4-mapped IPv6 and refuses non-canonical IPv4 spellings", async () => {
    dns.lookup.mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);
    expect(await notifyUrlBlockReason("https://evil.example/topic")).toBe("private address");
    // literal hostnames bypass DNS — checked directly (https so the
    // https-only rule doesn't fire before the address check)
    expect(await notifyUrlBlockReason("https://2130706433/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://0x7f.1/topic")).toBe("private address");
    // THE 0.6.2 CRITICAL: hex-form IPv4-mapped literals (the WHATWG URL
    // parser canonicalizes the dotted spelling to this) reached loopback
    // and cloud metadata before the fix
    expect(await notifyUrlBlockReason("https://[::ffff:7f00:1]/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://[::ffff:a9fe:a9fe]/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://[::ffff:c0a8:101]/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://[::ffff:10.1.2.3]/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://[64:ff9b::7f00:1]/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://[2002:7f00:1::]/topic")).toBe("private address");
    expect(await notifyUrlBlockReason("https://100.64.1.1/topic")).toBe("private address"); // CGNAT
  });

  it("allows public targets, refuses non-http(s) and DNS failures", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect(await notifyUrlBlockReason("https://ntfy.sh/my-topic")).toBeNull();
    expect(await notifyUrlBlockReason("ftp://ntfy.sh/x")).toBe("protocol");
    dns.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await notifyUrlBlockReason("https://nope.invalid/topic")).toBe("DNS");
  });

  it("plain http is refused while the guard is active (rebinding), allowed via the opt-in", async () => {
    expect(await notifyUrlBlockReason("http://ntfy.example/topic")).toMatch(/^http \(https required/);
    process.env.NOTIFY_ALLOW_PRIVATE_URLS = "1";
    expect(await notifyUrlBlockReason("http://192.168.1.50:8080/ntfy-topic")).toBeNull();
  });

  it("NOTIFY_ALLOW_PRIVATE_URLS=1 is the deployer's explicit LAN opt-in", async () => {
    process.env.NOTIFY_ALLOW_PRIVATE_URLS = "1";
    expect(await notifyUrlBlockReason("http://192.168.1.50:8080/ntfy-topic")).toBeNull();
  });

  it("sendPush never follows redirects (SSRF relay) and reports refusal as false", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ok = await sendPush("https://ntfy.sh/topic", { title: "T", message: "m" });
    expect(ok).toBe(true);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1]!.redirect).toBe("error");
  });
});
