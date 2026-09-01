/**
 * DB tests for the billing-day DASHBOARD page — the page that 500'd invisibly
 * for two fleets (a NUL byte + use-before-declaration corruption; nothing
 * rendered, nothing tested). The page is invoked as the async server
 * component it is; assertions walk the returned React element tree.
 *
 * Pins, in order of how expensive their silence was:
 *  - it RENDERS: the header line, the placed-since / billable-now cards;
 *  - copy-tab dedup: a tracked tab duplicating another's rows must not
 *    double the placed-since footage (200 ft, not 400), the open hole
 *    (1 hole once, not 2), or the billable-now count (1 row, not 2);
 *  - meta-prefix classification: a worklist row whose ACTIVITY text contains
 *    "BILLABLE" stays on the to-enter list — classification keys on the
 *    packet row's meta prefix, never on detail substrings the sheet controls;
 *  - a sheet with no baseline says footage is unknowable — never a confident 0.
 *
 * Same harness contract as report/page.db.test.ts: temp DATABASE_PATH before
 * any db-dependent import (all dynamic), next/headers mocked with a signed
 * session cookie.
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
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/sheet/print-button", () => ({ PrintButton: () => null }));

import { beforeAll, describe, expect, it } from "vitest";
import { setupMigratedTempDb } from "@/test/db-harness";

setupMigratedTempDb("billing-page");

const { db } = await import("@/lib/db");
const { snapshots, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { default: BillingPage } = await import("./page");

/** Collect every text node from a React element tree (server components
 *  return plain element objects — no renderer needed to read the words).
 *  Child server components receive their DATA as props (a Row gets the
 *  BillingRow object), so plain objects are walked too — otherwise every
 *  row detail would be invisible to the assertions. */
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
    const obj = node as Record<string, unknown>;
    const props = "props" in obj ? (obj.props ?? {}) : obj;
    for (const v of Object.values(props)) textOf(v, out);
  }
  return out;
}
const pageText = (el: unknown) => textOf(el).join(" ").replace(/\s+/g, " ");

async function seedUser(id: string) {
  await db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@corp.com`, name: id, tokensEnc: "unused", createdAt: 1 });
}
async function seedSheet(id: string, title: string) {
  await db.insert(spreadsheets).values({
    id, userId: "owner", googleId: `gid-${id}`, title,
    url: `https://docs.google.com/spreadsheets/d/gid-${id}/edit`,
    createdAt: 1,
  });
}
async function seedTab(id: string, spreadsheetId: string, position: number) {
  await db.insert(tabs).values({ id, spreadsheetId, title: id, position, tracked: true, keyColumn: 0 });
}
async function seedSnapshot(id: string, tabId: string, runId: string, isBaseline: boolean, createdAt: number, grid: string[][]) {
  const data = toSnapshotData(grid);
  await db.insert(snapshots).values({
    id, tabId, runId, trigger: "manual", isBaseline,
    rowCount: data.rows.length, colCount: data.headers.length,
    dataBlob: encodeSnapshot(data), createdAt,
  });
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 25); // baselines
const T1 = T0 + DAY;
const T2 = T0 + 4 * DAY; // working tab's latest
const T3 = T0 + 5 * DAY; // copy tab's latest (newest — it may win the label, nothing else)

// the working tab carries the office's own ledger vocabulary: a GIS check
// column, an entered-downstream column, and an Invoice # column
const H = ["Activity", "Start STA", "End STA", "Crew #", "Date Complete", "Bore Log in GIS?", "Entered in InEight", "Invoice #"];
const grid = (...rows: string[][]) => [H, ...rows];
const BASE_ROWS = [["Plow", "0", "500", "CREW A", "8/20/2026", "", "", ""]];
// the new row's ACTIVITY literally contains "BILLABLE" — sheet-controlled
// text that must never steer the page's section classification
const LATE_ROWS = [
  ...BASE_ROWS,
  ["BILLABLE Bore", "700", "900", "CREW A", "8/27/2026", "y", "", ""],
];

const COPY_SHEET = "bp-copy";
const NOBASE_SHEET = "bp-nobase";

beforeAll(async () => {
  await seedUser("owner");
  await seedUser("stranger");
  await seedSheet(COPY_SHEET, "Copy Tab Money Tracker");
  await seedTab("PE-4", COPY_SHEET, 0);
  await seedTab("PE7", COPY_SHEET, 1); // the copy: tracked, identical rows
  await seedSnapshot("bp-p4-base", "PE-4", "bp0", true, T0, grid(...BASE_ROWS));
  await seedSnapshot("bp-p4-last", "PE-4", "bp1", false, T2, grid(...LATE_ROWS));
  await seedSnapshot("bp-p7-base", "PE7", "bp2", true, T1, grid(...BASE_ROWS));
  await seedSnapshot("bp-p7-last", "PE7", "bp3", false, T3, grid(...LATE_ROWS));

  // snapshots but NO baseline: footage-since is unknowable
  await seedSheet(NOBASE_SHEET, "No Baseline Tracker");
  await seedTab("nb-1", NOBASE_SHEET, 0);
  await seedSnapshot("bp-nb-a", "nb-1", "bp4", false, T0, grid(["Plow", "0", "100", "C", "8/20/2026", "", "", ""]));
  await seedSnapshot("bp-nb-b", "nb-1", "bp5", false, T2, grid(["Plow", "0", "200", "C", "8/28/2026", "", "", ""]));
});

const render = async (id: string) => BillingPage({ params: Promise.resolve({ id }) });

describe("temp-db harness", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("billing page: it renders (the corruption 500'd invisibly)", () => {
  it("shows the header line and the headline cards", async () => {
    state.userId = "owner";
    const page = await render(COPY_SHEET);
    expect(page).toBeDefined();
    const text = pageText(page);
    expect(text).toContain("Copy Tab Money Tracker");
    expect(text).toContain("billing day · snapshot");
    expect(text).toContain("placed since collection");
    expect(text).toContain("billable now");
    expect(text).toContain("open holes");
    expect(text).toContain("to enter");
  });

  it("copy tab counted once: 200 ft placed since (not 400), one hole (not two), one billable row (not two)", async () => {
    state.userId = "owner";
    const text = pageText(await render(COPY_SHEET));
    // placed since collection: 900 ft placed at latest vs 500 at baseline = 200,
    // counted once even though PE7 lists the identical rows
    expect(text).toContain("200");
    expect(text).not.toContain("400");
    // the unaccounted 500-700 hole appears exactly once across sections
    expect((text.match(/Unaccounted 500-700/g) ?? []).length).toBe(1);
    expect(text).toContain("1 hole");
    expect(text).not.toContain("2 holes");
    // billable now: exactly one completed/GIS-checked/never-entered row
    expect(text).toContain("1 row");
    expect(text).not.toContain("2 rows");
    // and the do-not-invoice section carries it
    expect(text).toContain("Do not invoice");
  });

  it("classifies rows by meta prefix: a NEW row whose activity says BILLABLE stays on the to-enter list", async () => {
    state.userId = "owner";
    const text = pageText(await render(COPY_SHEET));
    // the worklist row (sheet-controlled activity text containing BILLABLE)
    expect(text).toContain("NEW row: BILLABLE Bore");
    // it lands under To enter downstream — substring classification would
    // have misfiled it into the invoice-ledger Billable section
    expect(text).toContain("To enter downstream");
    // the real billable row (from the invoice ledger) is the only one there
    expect(text).toContain("Billable — complete, in GIS, never entered");
  });

  it("no baseline: footage since says unknown, never a confident 0", async () => {
    state.userId = "owner";
    const text = pageText(await render(NOBASE_SHEET));
    expect(text).toContain("no collection point yet — footage since is unknown");
  });

  it("the placed-since card carries the ft unit (Fleet-16 UX LOW-3)", async () => {
    state.userId = "owner";
    const el = await render(COPY_SHEET);
    // find the Card element by its label prop — its VALUE is the assertion
    // ("200 ft", not the bare "200" that read as a row count)
    let value: string | undefined;
    const walk = (node: unknown): void => {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props && props.label === "placed since collection") {
        value = props.value as string;
        return;
      }
      for (const v of Object.values(props ?? {})) walk(v);
    };
    walk(el);
    expect(value).toBe("200 ft");
  });

  it("guards access: signed out redirects, a stranger 404s", async () => {
    state.userId = null;
    await expect(render(COPY_SHEET)).rejects.toThrow("REDIRECT");
    state.userId = "stranger";
    await expect(render(COPY_SHEET)).rejects.toThrow("NOT_FOUND");
  });
});
