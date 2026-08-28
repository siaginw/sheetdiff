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
import { captureSnapshot, computeNextRun } from "./snapshots";

async function requireUserId(): Promise<string> {
  const id = await getSessionUserId();
  if (!id) redirect("/");
  return id;
}

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "");
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
  await requireUserId();
  const id = str(fd, "spreadsheetId");
  await captureSnapshot(id, "manual");
  revalidatePath(`/sheets/${id}`);
  revalidatePath("/");
}

/** Mark a whole snapshot run as the "collected" baseline (per-sheet unique). */
export async function setBaseline(fd: FormData): Promise<void> {
  await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const runId = str(fd, "runId");

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
  await requireUserId();
  const id = str(fd, "spreadsheetId");
  const kind = (str(fd, "kind") || "off") as ScheduleKind;

  const rows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, id));
  const sheet = rows[0];
  if (!sheet) return;

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
  await requireUserId();
  const spreadsheetId = str(fd, "spreadsheetId");
  const tabId = str(fd, "tabId");
  const key = str(fd, "keyColumn"); // "auto" | "0" | "1" ...
  await db
    .update(tabs)
    .set({
      tracked: str(fd, "tracked") === "on",
      keyColumn: key === "auto" ? null : Number(key),
    })
    .where(eq(tabs.id, tabId));
  revalidatePath(`/sheets/${spreadsheetId}`);
}

export async function removeSheet(fd: FormData): Promise<void> {
  await requireUserId();
  const id = str(fd, "spreadsheetId");
  await db.delete(spreadsheets).where(eq(spreadsheets.id, id));
  revalidatePath("/");
  redirect("/");
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/");
}
