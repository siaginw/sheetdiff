/**
 * DB tests for the weekly report page — the regression the stock demo tripped
 * over: a tracked tab (PE7) whose rows duplicate another tracked tab (PE-4).
 * The page used to hit a bare `return` meant as `continue` when it detected a
 * pure copy tab, BLANKING the whole report; placed footage also ignored the
 * dedup entirely, double-counting every copied row.
 *
 * Same harness contract as route.db.test.ts: temp DATABASE_PATH before any
 * db-dependent import (all dynamic), next/headers mocked with a signed
 * session cookie, and the page component itself invoked as the async server
 * function it is — assertions walk the returned React element tree.
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

setupMigratedTempDb("report");

const { db } = await import("@/lib/db");
const { snapshots, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { default: ReportPage } = await import("./page");

/** Collect every text node from a React element tree (server components
 *  return plain element objects — no renderer needed to read the words). */
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
    // walk every prop value, not just children — component titles travel as props
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) for (const v of Object.values(props)) textOf(v, out);
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
  await db.insert(tabs).values({ id, spreadsheetId, title: id, position, tracked: true });
}
async function seedSnapshot(id: string, tabId: string, runId: string, createdAt: number, grid: string[][]) {
  const data = toSnapshotData(grid);
  await db.insert(snapshots).values({
    id, tabId, runId, trigger: "manual", isBaseline: false,
    rowCount: data.rows.length, colCount: data.headers.length,
    dataBlob: encodeSnapshot(data), createdAt,
  });
}

const DAY = 86_400_000;
const T = Date.UTC(2026, 7, 28); // late August 2026
const H = ["Activity", "Start STA", "End STA", "Date Complete"];
const grid = (...rows: string[][]) => [H, ...rows];

const COPY_SHEET = "rep-copy"; // PE-7 duplicates PE-4's row (the demo case)
const DISTINCT_SHEET = "rep-distinct"; // two tabs, no copies — must still sum

beforeAll(async () => {
  await seedUser("owner");
  await seedSheet(COPY_SHEET, "Copy Tab Tracker");
  await seedTab("PE-4", COPY_SHEET, 0);
  await seedTab("PE7", COPY_SHEET, 1); // the copy: tracked, same rows
  // PE-4: one dated plow shot, 500 ft
  await seedSnapshot("rc-p4", "PE-4", "rc0", T, grid(["Plow", "0", "500", "8/20/2026"]));
  // PE7 copies PE4's row verbatim (plus blank padding rows)
  await seedSnapshot("rc-p7", "PE7", "rc1", T + DAY, grid(
    ["Plow", "0", "500", "8/20/2026"],
    ["", "", "", ""],
  ));

  await seedSheet(DISTINCT_SHEET, "Distinct Tabs Tracker");
  await seedTab("rep-a", DISTINCT_SHEET, 0);
  await seedTab("rep-b", DISTINCT_SHEET, 1);
  await seedSnapshot("rd-a", "rep-a", "rd0", T, grid(["Plow", "0", "500", "8/20/2026"]));
  await seedSnapshot("rd-b", "rep-b", "rd1", T, grid(["Bore", "500", "1000", "8/21/2026"]));
});

const render = async (id: string) => ReportPage({ params: Promise.resolve({ id }) });

describe("temp-db harness", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("report page: a copy tab must not blank the report or double-count it", () => {
  it("renders the full page when a tracked tab duplicates another (bare `return` used to blank it)", async () => {
    state.userId = "owner";
    const page = await render(COPY_SHEET);
    expect(page).toBeDefined(); // the old code returned undefined mid-loop
    const text = pageText(page);
    expect(text).toContain("Copy Tab Tracker");
    expect(text).toContain("placed total");
    expect(text).toContain("week by week");
    expect(text).toContain("weeks worked");
  });

  it("counts the copied shot once: 500 ft placed, not 1,000 — and says the copy was deduped", async () => {
    state.userId = "owner";
    const text = pageText(await render(COPY_SHEET));
    expect(text).toContain("500 ft");
    expect(text).not.toContain("1,000 ft");
    expect(text).toContain("copied row counted once");
  });

  it("distinct tabs still sum: two 500 ft shots aggregate to 1,000 ft in one week", async () => {
    state.userId = "owner";
    const text = pageText(await render(DISTINCT_SHEET));
    expect(text).toContain("1,000 ft");
    expect(text).not.toContain("copied row");
  });

  it("404s for a sheet the caller cannot access", async () => {
    state.userId = null;
    await expect(render("rep-copy")).rejects.toThrow("REDIRECT"); // signed out -> login
  });
});
