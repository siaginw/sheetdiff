/**
 * GENERIC-SHEET ACCEPTANCE — SheetDiff on a sheet with NO stations, no crews,
 * no construction vocabulary: an inventory tracker keyed by SKU with a
 * compilation "Master List" that re-lists the working tab (retyped headers).
 *
 * The whole product must work here: diffs resolve, counts agree across every
 * surface, the compilation copy contributes nothing, and the billing packet
 * says footage is unknown instead of a confident 0 ft.
 */
import { vi } from "vitest";

const state = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const { signValue } = await import("@/lib/crypto");
    return {
      get: (name: string) =>
        name === "sd_session" && state.userId
          ? { value: signValue(state.userId, 30 * 24 * 3_600_000) }
          : undefined,
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
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async () => {} }) },
}));
vi.mock("@/components/sheet/print-button", () => ({ PrintButton: () => null }));
vi.mock("@/lib/google", () => ({
  parseSpreadsheetId: (s: string) => s.match(/[a-zA-Z0-9-_]{20,}/)?.[0] ?? null,
  fetchSpreadsheetMeta: async () => ({ title: "Scratch", tabs: [] }),
  getUserClient: async () => ({}),
  fetchTabValues: async () => ({}),
  googleConfigured: () => false,
}));

import { beforeAll, describe, expect, it } from "vitest";
import { setupMigratedTempDb } from "@/test/db-harness";

setupMigratedTempDb("generic");

const { db } = await import("@/lib/db");
const { snapshots, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { pureCopyTabIds } = await import("@/lib/pending");
const { buildDigestSheets } = await import("@/lib/digest");
const { default: Dashboard } = await import("@/app/page");
const { GET: worklistCsvGet } = await import("@/app/sheets/[id]/export/route");
const { GET: queueCsvGet } = await import("@/app/sheets/[id]/export/queue/route");
const { GET: billingCsvGet } = await import("@/app/sheets/[id]/export/billing/route");

const DAY = 86_400_000;
const T1 = Date.now() - 6 * DAY; // baseline
const T2 = Date.now() - 1_000; // latest
const SHEET = "inv-sheet";
const TAB_STOCK = "inv-stock";
const TAB_MASTER = "inv-master"; // compilation copy (retyped headers, new keys)

const STOCK_H = ["SKU", "Item", "Qty", "Warehouse", "Received", "Entered in System"];
const STOCK_BASE = [
  ["A-100", "Pump 2in", "4", "Yard 1", "8/1/2026", "y"],
  ["B-220", "Valve 6in", "12", "Yard 2", "8/2/2026", "y"],
  ["C-330", "Coupler", "40", "Trailer 3", "8/3/2026", ""], // unentered at baseline
];
const STOCK_LATEST = [
  ...STOCK_BASE.slice(0, 2),
  ["C-330", "Coupler", "40", "Trailer 3", "8/3/2026", "y"], // entered since
  ["D-440", "Meter 1in", "25", "Yard 1", "8/20/2026", ""], // NEW — unentered
  ["E-550", "Spool 500ft", "6", "Trailer 3", "8/21/2026", ""], // NEW — unentered
];
// the compilation copy: same key values, retyped headers/values — keyed by
// its OWN unique "Part" column, so the tier differs from Stock's
const MASTER_LATEST = [
  ["Part", "Description", "On Hand", "Yard"],
  ["A-100", "Pump 2", "4", "Yard 1"],
  ["B-220", "Valve 6", "12", "Yard 2"],
  ["C-330", "Coupler", "40", "Trailer 3"],
  ["D-440", "Meter 1", "25", "Yard 1"],
  ["E-550", "Spool 500", "6", "Trailer 3"],
];

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
    const props = "props" in (node as Record<string, unknown>) ? (node as { props?: Record<string, unknown> }).props ?? {} : node;
    for (const v of Object.values(props)) textOf(v, out);
  }
  return out;
}
const pageText = (el: unknown) => textOf(el).join(" ").replace(/\s+/g, " ");

async function csvBody(get: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>): Promise<string> {
  const res = await get(new Request("http://localhost/"), { params: Promise.resolve({ id: SHEET }) });
  expect(res.status).toBe(200);
  return res.text();
}

beforeAll(async () => {
  state.userId = "owner";
  await db.insert(users).values({ id: "owner", googleSub: "s", email: "o@x.com", name: "o", tokensEnc: "x", createdAt: 1 });
  await db.insert(spreadsheets).values({
    id: SHEET, userId: "owner", googleId: "g", title: "Inventory Tracker",
    url: "https://x", createdAt: 1, scheduleKind: "off", lastSnapshotAt: T2,
  });
  await db.insert(tabs).values([
    { id: TAB_STOCK, spreadsheetId: SHEET, title: "Stock", position: 0, tracked: true },
    { id: TAB_MASTER, spreadsheetId: SHEET, title: "Master List", position: 1, tracked: true },
  ]);
  const snap = (id: string, tabId: string, runId: string, isBaseline: boolean, createdAt: number, grid: string[][]) => {
    const data = toSnapshotData(grid);
    return { id, tabId, runId, trigger: "manual" as const, isBaseline, rowCount: data.rows.length, colCount: data.headers.length, dataBlob: encodeSnapshot(data), createdAt };
  };
  await db.insert(snapshots).values([
    snap("inv-s0", TAB_STOCK, "r0", true, T1, [STOCK_H, ...STOCK_BASE]),
    snap("inv-s1", TAB_STOCK, "r1", false, T2, [STOCK_H, ...STOCK_LATEST]),
    // Master List appears only in the latest run — no collection point of its own
    snap("inv-m1", TAB_MASTER, "r1", false, T2, MASTER_LATEST),
  ]);
});

describe("a generic inventory sheet (no stations, no construction vocabulary)", () => {
  it("classifies the Master List as a compilation copy via the auto-detected key column", async () => {
    const sheetTabs = await db.select().from(tabs);
    const copies = await pureCopyTabIds(sheetTabs);
    expect(copies.has(TAB_MASTER)).toBe(true);
    expect(copies.has(TAB_STOCK)).toBe(false);
  });

  it("every count surface shows the SAME to-enter number (2 new rows)", async () => {
    // hand computation: since the r0 collection, Stock added D-440 and E-550;
    // C-330's edit is the entered-column fill (1 changed row). Master List is
    // a copy — its appearance contributes NOTHING (no collection point and
    // excluded regardless).
    const dashboardText = pageText(await Dashboard({ searchParams: Promise.resolve({}) }));
    expect(dashboardText).toMatch(/3 not yet entered in the office system/);

    const worklist = await csvBody(worklistCsvGet);
    const worklistRows = worklist.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("Tab,")).length;
    // 2 added rows + 1 changed row (C-330 entered:y) = 3 worklist lines
    expect(worklistRows).toBe(3);
    expect(worklist).toContain("D-440");
    expect(worklist).toContain("E-550");
    expect(worklist).not.toContain("Master List"); // the copy stays out of the typing list

    const queue = await csvBody(queueCsvGet);
    expect(queue).toContain("D-440");
    expect(queue).not.toContain("Master List");

    const digest = await buildDigestSheets("owner");
    expect(digest.find((s) => s.id === SHEET)?.unresolved).toBe(3); // 2 added + 1 changed
  });

  it("the billing packet is HONEST about footage: unknown, never a confident 0 ft", async () => {
    const body = await csvBody(billingCsvGet);
    expect(body).toMatch(/Placed since collection: COULD NOT DETERMINE — no collection marker or no station columns \(row-based sheet\)/);
    // the to-enter worklist still ships — that part of billing day is universal
    expect(body).toContain("D-440");
    expect(body).toContain("E-550");
  });

  it("the pending resolver runs the generic diff cleanly (rowKeys stable)", async () => {
    const { getPendingChanges } = await import("@/lib/pending");
    const stock = (await db.select().from(tabs)).find((t) => t.id === TAB_STOCK)!;
    const pending = await getPendingChanges(stock);
    expect(pending).not.toBeNull();
    expect(pending!.counts.added).toBe(2);
    expect(pending!.counts.changed).toBe(1);
    expect(pending!.counts.unresolved).toBe(3);
    // rowKeys are the engine's — unique within the tab
    const keys = pending!.unresolved.map((r) => r.rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
