"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { spreadsheets, tabs, snapshots, type ScheduleKind } from "./db/schema";
import { getSessionUserId, SESSION_COOKIE } from "./session";
import { parseSpreadsheetId, fetchSpreadsheetMeta } from "./google";
import { captureSnapshot, computeNextRun, toSnapshotData, encodeSnapshot } from "./snapshots";
import { setAck } from "./sync";
import { parseImportFile } from "./import";
import { notes as notesTable, users } from "./db/schema";

async function requireUserId(): Promise<string> {
  const id = await getSessionUserId();
  if (!id) redirect("/");
  return id;
}

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "");
}

/**
 * Ownership gate for every mutation: loads the spreadsheet and throws unless
 * it belongs to the signed-in user. Tab-keyed helpers join through tabs.
 * (Single-user today, but every action verifies anyway — defense in depth,
 * and the precondition for ever adding viewer accounts.)
 */
async function requireOwnedSpreadsheet(spreadsheetId: string, userId: string) {
  const rows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, spreadsheetId));
  const sheet = rows[0];
  if (!sheet || sheet.userId !== userId) throw new Error("Not your sheet");
  return sheet;
}

async function requireOwnedTab(tabId: string, userId: string) {
  const rows = await db
    .select({ tab: tabs, sheet: spreadsheets })
    .from(tabs)
    .innerJoin(spreadsheets, eq(tabs.spreadsheetId, spreadsheets.id))
    .where(eq(tabs.id, tabId));
  const row = rows[0];
  if (!row || row.sheet.userId !== userId) throw new Error("Not your tab");
  return row;
}

/** Add a spreadsheet and take the first snapshot immediately. */
export async function startTracking(fd: FormData): Promise<void> {
  const userId = await requireUserId();

  const googleId = parseSpreadsheetId(str(fd, "url"));
  if (!googleId) redirect("/sheets/new?error=bad-url");

  const { getUserClient } = await import("./google");
  const client = await getUserClient(userId);
  const meta = await fetchSpreadsheetMeta(client, googleId).catch(() => null);
  if (!meta) redirect("/sheets/new?error=cannot-read");

  const selectedTitles = fd
    .getAll("tab")
    .map((t) => String(t))
    .filter((t) => meta.tabs.some((mt) => mt.title === t));
  if (selectedTitles.length === 0) redirect("/sheets/new?url=" + encodeURIComponent(str(fd, "url")) + "&error=no-tabs");

  const id = crypto.randomUUID();
  await db.insert(spreadsheets).values({
    id,
    userId,
    googleId,
    title: meta.title,
    url: `https://docs.google.com/spreadsheets/d/${googleId}/edit`,
    scheduleKind: "off",
    createdAt: Date.now(),
  });

  await db.insert(tabs).values(
    meta.tabs
      .filter((t) => selectedTitles.includes(t.title))
      .map((t, i) => {
        const rawKey = str(fd, `key_${t.title}`);
        return {
          id: crypto.randomUUID(),
          spreadsheetId: id,
          title: t.title,
          position: i,
          tracked: true,
          keyColumn: rawKey === "" || rawKey === "auto" ? null : Number(rawKey),
        };
      }),
  );

  await captureSnapshot(id, "manual");
  revalidatePath("/");
  redirect(`/sheets/${id}`);
}

export async function snapshotNow(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const id = str(fd, "spreadsheetId");
  await requireOwnedSpreadsheet(id, userId);
  await captureSnapshot(id, "manual");
  revalidatePath(`/sheets/${id}`);
  revalidatePath("/");
}

/** Mark a whole snapshot run as the "collected" baseline (per-sheet unique). */
export async function setBaseline(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const runId = str(fd, "runId");
  await requireOwnedSpreadsheet(spreadsheetId, userId);

  const sheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, spreadsheetId));
  const tabIds = sheetTabs.map((t) => t.id);
  if (tabIds.length > 0) {
    await db.update(snapshots).set({ isBaseline: false }).where(inArray(snapshots.tabId, tabIds));
    if (runId) {
      await db
        .update(snapshots)
        .set({ isBaseline: true })
        .where(and(inArray(snapshots.tabId, tabIds), eq(snapshots.runId, runId)));
    }
  }
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

export async function updateSchedule(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const id = str(fd, "spreadsheetId");
  const kind = (str(fd, "kind") || "off") as ScheduleKind;

  const sheet = await requireOwnedSpreadsheet(id, userId);

  const updated = {
    scheduleKind: kind,
    scheduleHours: kind === "hourly" ? Math.max(1, Math.min(24, Number(str(fd, "hours")) || 1)) : null,
    scheduleTime: kind === "daily" || kind === "weekly" ? str(fd, "time") || "09:00" : null,
    scheduleDay: kind === "weekly" ? Math.max(0, Math.min(6, Number(str(fd, "day")) || 1)) : null,
  };
  const next: ScheduleKind = updated.scheduleKind;
  await db
    .update(spreadsheets)
    .set({ ...updated, nextRunAt: computeNextRun({ ...sheet, ...updated, scheduleKind: next }) })
    .where(eq(spreadsheets.id, id));
  revalidatePath(`/sheets/${id}`);
  revalidatePath("/");
}

export async function updateTabSettings(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const tabId = str(fd, "tabId");
  const key = str(fd, "keyColumn"); // "auto" | "0" | "1" ...
  await requireOwnedTab(tabId, userId);
  await db
    .update(tabs)
    .set({
      tracked: str(fd, "tracked") === "on",
      keyColumn: key === "auto" ? null : Number(key),
    })
    .where(eq(tabs.id, tabId));
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/"); // tracked toggles change dashboard counts
}

export async function removeSheet(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const id = str(fd, "spreadsheetId");
  await requireOwnedSpreadsheet(id, userId);
  await db.delete(spreadsheets).where(eq(spreadsheets.id, id));
  revalidatePath("/");
  redirect("/");
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/");
}

/* ------------------------------------------------------------------ */
/* audit notes                                                         */
/* ------------------------------------------------------------------ */

export async function addNote(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const body = str(fd, "body").trim();
  if (!body) return;
  await requireOwnedSpreadsheet(spreadsheetId, userId);
  const tabId = str(fd, "tabId") || null;
  const runId = str(fd, "runId") || null;
  const rowKey = str(fd, "rowKey") || null;
  await db.insert(notesTable).values({
    id: crypto.randomUUID(),
    spreadsheetId,
    tabId,
    runId,
    rowKey,
    body: body.slice(0, 2000),
    createdAt: Date.now(),
  });
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

export async function deleteNote(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const id = str(fd, "id");
  const spreadsheetId = str(fd, "spreadsheetId");
  await requireOwnedSpreadsheet(spreadsheetId, userId);
  await db.delete(notesTable).where(eq(notesTable.id, id));
  revalidatePath(`/sheets/${spreadsheetId}`);
}

/* ------------------------------------------------------------------ */
/* per-change sync acknowledgments                                     */
/* ------------------------------------------------------------------ */

export async function toggleAck(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const tabId = str(fd, "tabId");
  const rowKey = str(fd, "rowKey");
  const on = str(fd, "on") === "1";
  await requireOwnedTab(tabId, userId);
  await setAck(tabId, rowKey, on);
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

/* ------------------------------------------------------------------ */
/* digest settings                                                     */
/* ------------------------------------------------------------------ */

export async function saveDigestSettings(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const email = str(fd, "digestEmail").trim();
  const time = /^\d{1,2}:\d{2}$/.test(str(fd, "digestTime")) ? str(fd, "digestTime") : "07:00";
  const dayRaw = str(fd, "digestDay"); // "daily" | "0".."6"
  const day = dayRaw === "daily" || dayRaw === "" ? null : Math.max(0, Math.min(6, Number(dayRaw)));
  await db
    .update(users)
    .set({ digestEmail: email || null, digestTime: time, digestDay: day })
    .where(eq(users.id, userId));
  revalidatePath("/");
}

/* ------------------------------------------------------------------ */
/* GIS import                                                          */
/* ------------------------------------------------------------------ */

/**
 * Import a GIS export (CSV/XLSX) as snapshot run with trigger "import".
 * XLSX sheets are matched to tracked tabs by name; CSV maps to the chosen
 * tab (or the only tracked tab).
 */
export async function importGis(fd: FormData): Promise<void> {
  const userId = await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/sheets/${spreadsheetId}?error=import-no-file`);
  }

  const sheetRows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, spreadsheetId));
  const sheet = sheetRows[0];
  if (!sheet || sheet.userId !== userId) redirect("/");
  const tracked = await db.select().from(tabs).where(eq(tabs.spreadsheetId, spreadsheetId));

  let parsed: Awaited<ReturnType<typeof parseImportFile>>;
  try {
    parsed = await parseImportFile(file);
  } catch {
    redirect(`/sheets/${spreadsheetId}?error=import-bad-file`);
  }

  const runId = crypto.randomUUID();
  const now = Date.now();
  let stored = 0;
  let firstTabId: string | null = null;

  const store = (tabId: string, grid: string[][]) => {
    const data = toSnapshotData(grid);
    db.insert(snapshots).values({
      id: crypto.randomUUID(),
      tabId,
      runId,
      trigger: "import",
      isBaseline: false,
      rowCount: data.rows.length,
      colCount: data.headers.length,
      dataBlob: encodeSnapshot(data),
      createdAt: now,
    }).run();
    stored++;
    if (!firstTabId) firstTabId = tabId;
  };

  if (parsed.kind === "csv") {
    const target =
      tracked.find((t) => t.id === str(fd, "tabId") && t.tracked) ??
      tracked.find((t) => t.tracked) ??
      null;
    if (target) store(target.id, parsed.tables.csv);
  } else {
    for (const [sheetName, grid] of Object.entries(parsed.tables)) {
      const match = tracked.find((t) => t.tracked && t.title.toLowerCase() === sheetName.toLowerCase());
      if (match) store(match.id, grid);
    }
  }

  if (stored === 0) {
    redirect(`/sheets/${spreadsheetId}?error=import-no-match`);
  }

  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
  // land on the diff: latest sheet snapshot -> the fresh import
  redirect(`/sheets/${spreadsheetId}?tab=${encodeURIComponent(
    tracked.find((t) => t.id === firstTabId)?.title ?? "",
  )}&imported=${runId}`);
}
