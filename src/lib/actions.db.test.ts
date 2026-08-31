/**
 * Ownership-gate DB tests for src/lib/actions.ts — the sharing security
 * boundary, exercised against a real (temp) SQLite database.
 *
 * Harness notes (load-bearing):
 *  - vitest hoists static imports above module-body statements, so the temp
 *    DATABASE_PATH must be set BEFORE any ./db-dependent import — hence every
 *    such module is imported dynamically below. The first test asserts the
 *    connection really points at the temp file.
 *  - next/headers, next/cache, next/navigation and ./google are mocked. The
 *    session cookie is genuinely signed+verified (crypto.ts runs for real),
 *    so requireUser() resolves through the authentic session path.
 *  - Schema is created by the repo migrator into an empty temp file.
 */
import { vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  tabValues: {} as Record<string, string[][]>,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    const { signValue } = await import("./crypto");
    return {
      get: (name: string) =>
        name === "sd_session" && state.userId
          ? { value: signValue(state.userId, 30 * 24 * 3_600_000) }
          : undefined,
      delete: () => {},
    };
  },
}));
vi.mock("./google", () => ({
  parseSpreadsheetId: (s: string) => s.match(/[a-zA-Z0-9-_]{20,}/)?.[0] ?? null,
  fetchSpreadsheetMeta: async () => ({ title: "Scratch", tabs: [] }),
  getUserClient: async () => ({}),
  fetchTabValues: async () => state.tabValues,
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "actions-db-test-secret-0123456789";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-actions-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
fs.writeFileSync(process.env.DATABASE_PATH, "");
const repoRoot = process.cwd();
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "migrate.mjs")], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH },
  stdio: "pipe",
  timeout: 120_000,
});

const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("./db");
const { changeAcks, members, notes, snapshots, spreadsheets, tabs, users } = await import("./db/schema");
const { encodeSnapshot, toSnapshotData } = await import("./snapshots");
const { getSheetAccess } = await import("./access");
const { addMembers, addNote, removeMember, setBaseline, snapshotNow, toggleAck } = await import("./actions");

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const signIn = (id: string | null) => {
  state.userId = id;
};

async function seedUser(id: string, email: string | null) {
  await db.insert(users).values({ id, googleSub: `sub-${id}`, email, name: id, tokensEnc: "unused", createdAt: 1 });
}
async function seedSheet(id: string, userId: string, title: string) {
  await db.insert(spreadsheets).values({
    id, userId, googleId: `gid-${id}`, title,
    url: `https://docs.google.com/spreadsheets/d/gid-${id}/edit`,
    createdAt: 1,
  });
}
async function seedTab(id: string, spreadsheetId: string) {
  await db.insert(tabs).values({ id, spreadsheetId, title: id, position: 0, tracked: true });
}
async function seedSnapshot(tabId: string, runId: string, trigger: "manual" | "import", isBaseline: boolean, createdAt: number, grid: string[][]) {
  const data = toSnapshotData(grid);
  await db.insert(snapshots).values({
    id: crypto.randomUUID(), tabId, runId, trigger, isBaseline,
    rowCount: data.rows.length, colCount: data.headers.length,
    dataBlob: encodeSnapshot(data), createdAt,
  });
}

beforeAll(async () => {
  await seedUser("owner-1", "owner@corp.com");
  await seedUser("owner-2", "chief@corp.com");
  await seedUser("viewer-1", "ana@corp.com");
  await seedUser("stranger-1", "mallory@evil.example");
  await db.insert(members).values({ id: "member-1", ownerUserId: "owner-1", email: "ana@corp.com", createdAt: 1 });

  await seedSheet("sheet-1", "owner-1", "Main Tracker");
  await seedTab("tab-1", "sheet-1");
  await seedTab("tab-2", "sheet-1");
  await seedSheet("sheet-2", "owner-2", "Other Tracker");
  await seedTab("tab-3", "sheet-2");
  await seedSheet("sheet-3", "owner-1", "Capture Me");
  await seedTab("tab-4", "sheet-3");

  for (const tabId of ["tab-1", "tab-2"]) {
    await seedSnapshot(tabId, "run-manual", "manual", false, 1000, [["Shot", "Qty"], ["S1", "1"]]);
    await seedSnapshot(tabId, "run-import", "import", false, 2000, [["Shot", "Qty"], ["S1", "2"]]);
  }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* WAL held open on Windows */ }
});

describe("temp-db harness", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("snapshotNow ownership gate", () => {
  it("owner captures a real snapshot run", async () => {
    signIn("owner-1");
    state.tabValues = { tab4: [["Shot", "Qty"], ["S1", "5"]] } as never;
    await snapshotNow(fd({ spreadsheetId: "sheet-3" }));
    const rows = await db.select().from(snapshots).where(eq(snapshots.tabId, "tab-4"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe("manual");
  });

  it("viewer (member) is rejected — capture is owner-only", async () => {
    signIn("viewer-1");
    await expect(snapshotNow(fd({ spreadsheetId: "sheet-3" }))).rejects.toThrow(/Not your sheet/);
  });

  it("stranger is rejected", async () => {
    signIn("stranger-1");
    await expect(snapshotNow(fd({ spreadsheetId: "sheet-3" }))).rejects.toThrow(/Not your sheet/);
  });
});

describe("setBaseline shared gate", () => {
  it("stranger cannot set a baseline", async () => {
    signIn("stranger-1");
    await expect(setBaseline(fd({ spreadsheetId: "sheet-1", runId: "run-manual" }))).rejects.toThrow(/No access/);
  });

  it("GIS imports can never become the baseline; the manual run can; degenerate runIds are a NO-OP", async () => {
    signIn("owner-1");
    await setBaseline(fd({ spreadsheetId: "sheet-1", runId: "run-import" }));
    const afterImport = await db.select().from(snapshots).where(inArray(snapshots.tabId, ["tab-1", "tab-2"]));
    expect(afterImport.filter((r) => r.trigger === "import").every((r) => !r.isBaseline)).toBe(true);

    await setBaseline(fd({ spreadsheetId: "sheet-1", runId: "run-manual" }));
    const afterManual = await db.select().from(snapshots).where(inArray(snapshots.tabId, ["tab-1", "tab-2"]));
    expect(afterManual.filter((r) => r.trigger === "manual").every((r) => r.isBaseline)).toBe(true);

    // a viewer with a degenerate runId (empty, or a run from another sheet)
    // must NOT wipe every baseline — a state the UI can never produce, which
    // was previously reachable by tampering the form
    signIn("viewer-1");
    await setBaseline(fd({ spreadsheetId: "sheet-1", runId: "" }));
    await setBaseline(fd({ spreadsheetId: "sheet-1", runId: "run-from-another-sheet" }));
    const untouched = await db.select().from(snapshots).where(inArray(snapshots.tabId, ["tab-1", "tab-2"]));
    expect(untouched.filter((r) => r.trigger === "manual").every((r) => r.isBaseline)).toBe(true);
  });
});

describe("toggleAck shared-tab gate", () => {
  it("viewer can ack/un-ack; stranger cannot", async () => {
    signIn("viewer-1");
    await toggleAck(fd({ spreadsheetId: "sheet-1", tabId: "tab-1", rowKey: "shot-9", on: "1" }));
    expect(await db.select().from(changeAcks).where(eq(changeAcks.tabId, "tab-1"))).toHaveLength(1);
    await toggleAck(fd({ spreadsheetId: "sheet-1", tabId: "tab-1", rowKey: "shot-9", on: "0" }));
    expect(await db.select().from(changeAcks).where(eq(changeAcks.tabId, "tab-1"))).toHaveLength(0);

    signIn("stranger-1");
    await expect(
      toggleAck(fd({ spreadsheetId: "sheet-1", tabId: "tab-1", rowKey: "shot-9", on: "1" })),
    ).rejects.toThrow(/No access/);
  });
});

describe("addNote scope upsert + foreign tabId collapse", () => {
  it("upserts the author's note at one scope instead of stacking", async () => {
    signIn("owner-1");
    await addNote(fd({ spreadsheetId: "sheet-1", tabId: "tab-1", body: "first" }));
    await addNote(fd({ spreadsheetId: "sheet-1", tabId: "tab-1", body: "second" }));
    const rows = await db.select().from(notes).where(eq(notes.spreadsheetId, "sheet-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("second");
  });

  it("collapses a foreign tabId to a sheet-level note", async () => {
    signIn("owner-1");
    await addNote(fd({ spreadsheetId: "sheet-1", tabId: "tab-3", body: "sneaky" })); // tab-3 is sheet-2's
    const sneaky = (await db.select().from(notes).where(eq(notes.spreadsheetId, "sheet-1"))).find((n) => n.body === "sneaky");
    expect(sneaky!.tabId).toBeNull();
  });

  it("stranger rejected; empty body ignored", async () => {
    signIn("stranger-1");
    await expect(addNote(fd({ spreadsheetId: "sheet-1", body: "pwn" }))).rejects.toThrow(/No access/);
    signIn("owner-1");
    const before = (await db.select().from(notes).where(eq(notes.spreadsheetId, "sheet-1"))).length;
    await addNote(fd({ spreadsheetId: "sheet-1", body: "   " }));
    expect((await db.select().from(notes).where(eq(notes.spreadsheetId, "sheet-1"))).length).toBe(before);
  });
});

describe("addMembers / removeMember", () => {
  it("normalizes, dedups, drops invalid and self emails", async () => {
    signIn("owner-2"); // chief@corp.com
    await addMembers(fd({ emails: " Ana@Corp.com, ana@corp.com ; bob@corp.com not-an-email chief@corp.com " }));
    const rows = await db.select().from(members).where(eq(members.ownerUserId, "owner-2"));
    expect(rows.map((r) => r.email).sort()).toEqual(["ana@corp.com", "bob@corp.com"]);
  });

  it("membership grants viewer access by email; strangers get null", async () => {
    expect((await getSheetAccess("sheet-2", { id: "viewer-1", email: "ana@corp.com" }))?.role).toBe("viewer");
    expect(await getSheetAccess("sheet-2", { id: "stranger-1", email: "mallory@evil.example" })).toBeNull();
  });

  it("removeMember only deletes the caller's own members", async () => {
    const ana = (await db.select().from(members).where(eq(members.ownerUserId, "owner-2"))).find((m) => m.email === "ana@corp.com")!;
    signIn("owner-1"); // NOT owner-2
    await removeMember(fd({ id: ana.id }));
    expect((await db.select().from(members).where(eq(members.ownerUserId, "owner-2"))).length).toBe(2);
  });
});
