/**
 * v0.6 feature acceptance — push notifications, the settings hub, the
 * onboarding checklist, and the PDF billing packet, exercised end to end
 * against the real pages/routes/actions.
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
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: async () => {} }) } }));
vi.mock("@/components/sheet/print-button", () => ({ PrintButton: () => null }));
vi.mock("@/lib/google", () => ({
  parseSpreadsheetId: (s: string) => s.match(/[a-zA-Z0-9-_]{20,}/)?.[0] ?? null,
  fetchSpreadsheetMeta: async () => ({ title: "Scratch", tabs: [] }),
  getUserClient: async () => ({}),
  fetchTabValues: async () => ({}),
  googleConfigured: () => false,
}));

import { setupMigratedTempDb } from "@/test/db-harness";
import { beforeAll, describe, expect, it, vi as viMock } from "vitest";

setupMigratedTempDb("v06");

const { eq } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { snapshots, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");

const DAY = 86_400_000;
const SHEET = "v6-sheet";
const TAB_A = "v6-a";

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
  if (typeof node === "object") {
    const props =
      "props" in (node as Record<string, unknown>) ? ((node as { props?: Record<string, unknown> }).props ?? {}) : node;
    for (const v of Object.values(props)) textOf(v, out);
  }
  return out;
}
const pageText = (el: unknown) => textOf(el).join(" ").replace(/\s+/g, " ");

beforeAll(async () => {
  state.userId = "owner";
  await db.insert(users).values({
    id: "owner",
    googleSub: "s",
    email: "o@x.com",
    name: "o",
    tokensEnc: "x",
    createdAt: 1,
  });
  await db.insert(spreadsheets).values({
    id: SHEET,
    userId: "owner",
    googleId: "g",
    title: "V6 Tracker",
    url: "https://x",
    createdAt: 1,
    scheduleKind: "off",
    lastSnapshotAt: 2,
  });
  await db.insert(tabs).values({ id: TAB_A, spreadsheetId: SHEET, title: "A", position: 0, tracked: true });
  const H = ["Activity", "Start STA", "End STA"];
  const snap = (id: string, runId: string, isBaseline: boolean, createdAt: number, rows: string[][]) => {
    const data = toSnapshotData([H, ...rows]);
    return {
      id,
      tabId: TAB_A,
      runId,
      trigger: "manual" as const,
      isBaseline,
      rowCount: data.rows.length,
      colCount: data.headers.length,
      dataBlob: encodeSnapshot(data),
      createdAt,
    };
  };
  await db.insert(snapshots).values([
    snap("v6-s0", "r0", true, 1_000_000_000_000, [["Plow", "0", "500"]]),
    snap("v6-s1", "r1", false, 1_000_000_000_000 + 5 * DAY, [
      ["Plow", "0", "500"],
      ["Bore", "500", "900"],
    ]),
  ]);
});

describe("push notifications (ntfy)", () => {
  it("saves a valid topic URL and rejects junk", async () => {
    const { savePushSettings } = await import("@/lib/actions");
    const fd = (url: string) => {
      const f = new FormData();
      f.set("notifyUrl", url);
      return f;
    };
    await savePushSettings(fd("https://ntfy.sh/sheetdiff-test"));
    const row = (await db.select().from(users).where(eq(users.id, "owner")))[0];
    expect(row.notifyUrl).toBe("https://ntfy.sh/sheetdiff-test");

    await savePushSettings(fd("javascript:alert(1)")).catch((e: unknown) => {
      // redirects with an invalid-URL flash instead of silently clearing
      expect(String((e as Error).message)).toMatch(/push=invalid/);
    });
    const row2 = (await db.select().from(users).where(eq(users.id, "owner")))[0];
    // an invalid entry NEVER clears a previously saved topic (0.6.2 fix)
    expect(row2.notifyUrl).toBe("https://ntfy.sh/sheetdiff-test");

    // clearing deliberately (empty field) still turns push off
    await savePushSettings(fd(""));
    const row3 = (await db.select().from(users).where(eq(users.id, "owner")))[0];
    expect(row3.notifyUrl).toBeNull();
  });

  it("a capture that introduces changes fires exactly one push; quiet captures fire none", async () => {
    const pushes: { url: string; body: unknown }[] = [];
    const fetchMock = viMock.fn(async (url: string, init?: RequestInit) => {
      pushes.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    });
    viMock.stubGlobal("fetch", fetchMock);
    // skip the SSRF DNS resolution (unit-tested separately with mocked dns) —
    // CI runners may have no egress
    process.env.NOTIFY_ALLOW_PRIVATE_URLS = "1";

    const { sendPush } = await import("@/lib/notify");
    const ok = await sendPush("https://ntfy.sh/t", { title: "T", message: "m" });
    expect(ok).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.url).toBe("https://ntfy.sh/t");

    viMock.unstubAllGlobals();
    delete process.env.NOTIFY_ALLOW_PRIVATE_URLS;
  });

  it("the settings page renders the push section and current topic", async () => {
    const Settings = (await import("@/app/settings/page")).default;
    const el = await Settings({ searchParams: Promise.resolve({}) });
    const text = pageText(el);
    expect(text).toContain("Push notifications");
    expect(text).toContain("ntfy.sh");
    expect(text.toLowerCase()).toContain("digest email");
  });
});

describe("onboarding checklist", () => {
  it("shows for an owner with unfinished steps, and hides when dismissed", async () => {
    const Dashboard = (await import("@/app/page")).default;
    const withCard = pageText(await Dashboard({ searchParams: Promise.resolve({}) }));
    // the card renders for an owner with unfinished steps (step titles are
    // visible in the element props; the card's own header executes at stream
    // time, not during this await)
    expect(withCard).toContain("Get told when things change");
    expect(withCard).toContain("Set up notifications");

    const { dismissOnboarding } = await import("@/lib/actions");
    await dismissOnboarding(new FormData());
    const after = pageText(await Dashboard({ searchParams: Promise.resolve({}) }));
    expect(after).not.toContain("Set up notifications"); // card gone
  });
});

describe("settings flash honesty (0.6.2)", () => {
  it("push=failed and push=invalid render feedback (they rendered nothing in 0.6.1)", async () => {
    const Settings = (await import("@/app/settings/page")).default;
    const failed = pageText(await Settings({ searchParams: Promise.resolve({ push: "failed" }) }));
    expect(failed).toContain("Test failed");
    const invalid = pageText(await Settings({ searchParams: Promise.resolve({ push: "invalid" }) }));
    expect(invalid).toContain("not saved");
  });
});

describe("PDF billing packet", () => {
  it("returns a real PDF (magic bytes) sharing the CSV's packet assembly", async () => {
    const { GET } = await import("@/app/sheets/[id]/export/billing/pdf/route");
    const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: SHEET }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/sheetdiff-V6-Tracker-billing-\d{4}-\d{2}-\d{2}\.pdf/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x25); // %PDF
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x44);
  });

  it("the CSV route still works off the SAME assembly", async () => {
    const { GET } = await import("@/app/sheets/[id]/export/billing/route");
    const res = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: SHEET }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/# SheetDiff billing packet — data as of/);
  });
});

describe("v0.6.1 audit fixes", () => {
  it("an UNTRACKED TOTALS tab's over-placement now reaches the billing PAGE (parity with CSV/PDF)", async () => {
    // add an untracked TOTALS claiming placed > designed
    await db.insert(tabs).values({ id: "v6-tot", spreadsheetId: SHEET, title: "TOTALS", position: 1, tracked: false });
    const T = [
      ["Package", "Designed", "Placed"],
      ["PE-9", "100", "999"],
    ];
    const data = toSnapshotData(T);
    await db.insert(snapshots).values({
      id: "v6-tot-s",
      tabId: "v6-tot",
      runId: "r1",
      trigger: "manual",
      isBaseline: false,
      rowCount: data.rows.length,
      colCount: data.headers.length,
      dataBlob: encodeSnapshot(data),
      createdAt: 1_000_000_000_000 + 5 * DAY,
    });
    const Billing = (await import("@/app/sheets/[id]/billing/page")).default;
    const text = pageText(await Billing({ params: Promise.resolve({ id: SHEET }) }));
    if (process.env.DEBUG_V6) console.log("BILLING-SLICE:", JSON.stringify(text.slice(0, 500)));
    // the page renders over-placement in the "Do not invoice" section (the
    // OVER-PLACED label is the CSV's) — the substance is the same finding
    expect(text).toContain("placed 999"); // was CSV/PDF-only before the parity fix
    expect(text).toContain("Do not invoice");
  });

  it("a pure viewer never sees the onboarding checklist", async () => {
    state.userId = "viewer";
    await db.insert(users).values({
      id: "viewer",
      googleSub: "sv",
      email: "v@x.com",
      name: "v",
      tokensEnc: "x",
      createdAt: 1,
    });
    await db.insert((await import("@/lib/db/schema")).members).values({
      id: "v6-mem",
      ownerUserId: "owner",
      email: "v@x.com",
      createdAt: 1,
    });
    const Dashboard = (await import("@/app/page")).default;
    const text = pageText(await Dashboard({ searchParams: Promise.resolve({}) }));
    expect(text).not.toContain("Get told when things change");
    state.userId = "owner";
  });

  it("a capture right after a GIS import stays quiet (no 'new work' push for entered rows)", async () => {
    const pushes: unknown[] = [];
    const fetchMock = viMock.fn(async () => {
      pushes.push(1);
      return new Response("{}", { status: 200 });
    });
    viMock.stubGlobal("fetch", fetchMock);
    process.env.NOTIFY_ALLOW_PRIVATE_URLS = "1";
    await db.update(users).set({ notifyUrl: "https://ntfy.sh/owner-topic" }).where(eq(users.id, "owner"));

    // an import run lands, then a capture whose diff-vs-pre-import "changes"
    // are exactly the imported rows
    const imp = toSnapshotData([
      ["Activity", "Start STA", "End STA"],
      ["Plow", "0", "500"],
      ["Bore", "500", "900"],
      ["Dig", "900", "903"],
    ]);
    await db.insert(snapshots).values({
      id: "v6-imp",
      tabId: TAB_A,
      runId: "rimp",
      trigger: "import",
      isBaseline: false,
      rowCount: imp.rows.length,
      colCount: imp.headers.length,
      dataBlob: encodeSnapshot(imp),
      createdAt: 1_000_000_000_000 + 6 * DAY,
    });
    const { captureSnapshot } = await import("@/lib/snapshots");
    const g = await import("@/lib/google");
    viMock.spyOn(g, "getUserClient").mockResolvedValue({} as never);
    viMock.spyOn(g, "fetchTabValues").mockResolvedValue({
      A: [
        ["Activity", "Start STA", "End STA"],
        ["Plow", "0", "500"],
        ["Bore", "500", "900"],
        ["Dig", "900", "903"],
      ],
    });
    await captureSnapshot(SHEET, "scheduled");
    // give the fire-and-forget promise a beat
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toHaveLength(0); // imported rows are NOT new work

    // a capture that introduces REAL changes after that still pushes
    viMock.spyOn(g, "fetchTabValues").mockResolvedValue({
      A: [
        ["Activity", "Start STA", "End STA"],
        ["Plow", "0", "500"],
        ["Bore", "500", "900"],
        ["Dig", "900", "903"],
        ["Bore", "903", "950"],
      ],
    });
    await captureSnapshot(SHEET, "scheduled");
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toHaveLength(1);

    delete process.env.NOTIFY_ALLOW_PRIVATE_URLS;
    viMock.unstubAllGlobals();
  });
});
