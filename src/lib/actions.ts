"use server";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getSheetAccess } from "./access";
import { db } from "./db";
import { members, notes as notesTable, snapshots, spreadsheets, tabs, users, type ScheduleKind } from "./db/schema";
import { fetchSpreadsheetMeta, parseSpreadsheetId } from "./google";
import { parseImportFile } from "./import";
import { logger } from "./logger";
import { getPendingChanges } from "./pending";
import { getSessionUserId, SESSION_COOKIE } from "./session";
import { captureSnapshot, computeNextRun, encodeSnapshot, toSnapshotData } from "./snapshots";
import { setAck } from "./sync";

async function requireUser(): Promise<typeof users.$inferSelect> {
  const id = await getSessionUserId();
  if (!id) redirect("/");
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!rows[0]) redirect("/");
  return rows[0];
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

/** Access for shared actions: owner OR viewer (member by email). */
async function requireSharedSpreadsheet(spreadsheetId: string, user: { id: string; email: string | null }) {
  const access = await getSheetAccess(spreadsheetId, user);
  if (!access) throw new Error("No access to this sheet");
  return access;
}

async function requireSharedTab(tabId: string, user: { id: string; email: string | null }) {
  const rows = await db
    .select({ tab: tabs, sheet: spreadsheets })
    .from(tabs)
    .innerJoin(spreadsheets, eq(tabs.spreadsheetId, spreadsheets.id))
    .where(eq(tabs.id, tabId));
  const row = rows[0];
  if (!row) throw new Error("No such tab");
  const access = await getSheetAccess(row.sheet.id, user);
  if (!access) throw new Error("No access to this tab");
  return { ...row, ...access };
}

/** Add a spreadsheet and take the first snapshot immediately. */
export async function startTracking(fd: FormData): Promise<void> {
  const user = await requireUser();
  const userId = user.id;

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
  const cadence = str(fd, "cadence");
  const schedule =
    cadence === "daily-9"
      ? { scheduleKind: "daily" as const, scheduleTime: "09:00" }
      : cadence === "daily-16"
        ? { scheduleKind: "daily" as const, scheduleTime: "16:00" }
        : cadence === "hourly"
          ? { scheduleKind: "hourly" as const, scheduleHours: 1 }
          : { scheduleKind: "off" as const };
  await db.insert(spreadsheets).values({
    id,
    userId,
    googleId,
    title: meta.title,
    url: `https://docs.google.com/spreadsheets/d/${googleId}/edit`,
    ...schedule,
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

  try {
    await captureSnapshot(id, "manual");
  } catch (err) {
    // never leave a ghost sheet with zero snapshots — a retry would duplicate it
    logger.error({ err: err instanceof Error ? err.message : err }, "[startTracking] first capture failed");
    await db.delete(spreadsheets).where(eq(spreadsheets.id, id));
    redirect("/sheets/new?url=" + encodeURIComponent(str(fd, "url")) + "&error=cannot-read");
  }
  revalidatePath("/");
  redirect(`/sheets/${id}`);
}

export async function snapshotNow(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(fd, "spreadsheetId");
  await requireOwnedSpreadsheet(id, user.id);
  try {
    await captureSnapshot(id, "manual");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "[snapshot] manual capture failed");
    const { recordCaptureFailure } = await import("./snapshots");
    await recordCaptureFailure(id, err);
    redirect(`/sheets/${id}?error=snapshot-failed`);
  }
  revalidatePath(`/sheets/${id}`);
  revalidatePath("/");
}

/** Mark a whole snapshot run as the "collected" baseline (per-sheet unique).
 *  Owners AND viewers (the person doing the collecting) may set it. */
export async function setBaseline(fd: FormData): Promise<void> {
  const user = await requireUser();
  const spreadsheetId = str(fd, "spreadsheetId");
  const runId = str(fd, "runId");
  await requireSharedSpreadsheet(spreadsheetId, user);

  const sheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, spreadsheetId));
  const tabIds = sheetTabs.map((t) => t.id);
  // A runId that matches no non-import run of this sheet is a stale form or a
  // tampered one — it must be a NO-OP. The wipe-then-set below with a bogus
  // runId would clear every baseline and blind the pending resolver, a state
  // the UI can never produce on its own.
  const coveredTabIds =
    runId && tabIds.length > 0
      ? (
          await db
            .selectDistinct({ tabId: snapshots.tabId })
            .from(snapshots)
            .where(and(inArray(snapshots.tabId, tabIds), eq(snapshots.runId, runId), ne(snapshots.trigger, "import")))
        ).map((r) => r.tabId)
      : [];
  const runExists = coveredTabIds.length > 0;
  let undoToken: string | null = null;
  if (runExists) {
    // ONE atomic statement, scoped to the tabs the marked run actually covers:
    // a wipe-then-set pair is not a transaction (a mid-flight reader sees zero
    // baselines and reports "up to date" on unentered work), two racing calls
    // can interleave into two baselines, and a global wipe strips baselines
    // from tabs the run predates. The CASE handles "GIS imports can never be
    // the collected baseline" in the same breath.
    // Remember the CURRENT per-tab baselines of exactly the covered tabs so
    // the UI can offer undo — ONE runId for the whole sheet is not enough
    // when tabs were collected at different runs (a run covering a tab
    // subset — a tab added later): restoring a single run left those tabs
    // collected and silently hid un-entered work behind a success flash.
    // "Mark as collected" is the product's only destructive action, and with
    // exactly 2 snapshots there is no way back without this.
    const prevRows = await db
      .selectDistinct({ tabId: snapshots.tabId, runId: snapshots.runId })
      .from(snapshots)
      .where(
        and(inArray(snapshots.tabId, coveredTabIds), eq(snapshots.isBaseline, true), ne(snapshots.trigger, "import")),
      );
    const payload = Buffer.from(
      JSON.stringify({ r: runId, p: prevRows.map((x) => [x.tabId, x.runId]) }),
      "utf8",
    ).toString("base64url");
    // absurdly wide sheets (60+ tabs) would overflow the URL — degrade to no
    // undo offer rather than a redirect that 414s
    undoToken = payload.length <= 6000 ? payload : null;

    await db
      .update(snapshots)
      .set({ isBaseline: sql`(run_id = ${runId} AND trigger <> 'import')` })
      .where(
        inArray(
          snapshots.tabId,
          db
            .selectDistinct({ tabId: snapshots.tabId })
            .from(snapshots)
            .where(and(eq(snapshots.runId, runId), ne(snapshots.trigger, "import"))),
        ),
      );

    // land on the CLEAN since-collection view with the undo token in the URL
    redirect(`/sheets/${spreadsheetId}?collected=1${undoToken ? `&undo=${encodeURIComponent(undoToken)}` : ""}`);
  }
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

/** Undo the last "Mark as collected": restore the EXACT per-tab baseline
 *  state the token captured — every tab the marked run covered goes back to
 *  its previous collection point (or to none, if it had never been
 *  collected). Validated against the sheet so a stale or tampered token is a
 *  no-op, never a corruption. */
export async function undoBaseline(fd: FormData): Promise<void> {
  const user = await requireUser();
  const spreadsheetId = str(fd, "spreadsheetId");
  const token = str(fd, "token");
  await requireSharedSpreadsheet(spreadsheetId, user);
  if (!token) redirect(`/sheets/${spreadsheetId}`);

  let parsed: { r?: unknown; p?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    redirect(`/sheets/${spreadsheetId}?error=bad-undo`);
  }
  const markedRun = typeof parsed.r === "string" ? parsed.r : null;
  const pairs = Array.isArray(parsed.p)
    ? parsed.p.filter(
        (x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string",
      )
    : [];
  if (!markedRun) redirect(`/sheets/${spreadsheetId}?error=bad-undo`);

  const sheetTabs = await db.select().from(tabs).where(eq(tabs.spreadsheetId, spreadsheetId));
  const tabIds = new Set(sheetTabs.map((t) => t.id));

  // the tabs the marked run covered — the ONLY tabs undo touches
  const covered = (
    await db
      .selectDistinct({ tabId: snapshots.tabId })
      .from(snapshots)
      .where(
        and(inArray(snapshots.tabId, [...tabIds]), eq(snapshots.runId, markedRun), ne(snapshots.trigger, "import")),
      )
  ).map((r) => r.tabId);
  if (covered.length === 0) redirect(`/sheets/${spreadsheetId}?error=bad-undo`);

  // every pair must be a real non-import run of THIS sheet on THAT tab —
  // anything else is a stale or tampered token
  const restore = new Map<string, string>();
  for (const [tabId, runId] of pairs) {
    if (!tabIds.has(tabId) || !covered.includes(tabId)) continue;
    const ok =
      (
        await db
          .select({ tabId: snapshots.tabId })
          .from(snapshots)
          .where(and(eq(snapshots.tabId, tabId), eq(snapshots.runId, runId), ne(snapshots.trigger, "import")))
          .limit(1)
      ).length > 0;
    if (ok) restore.set(tabId, runId);
  }

  // better-sqlite3 transactions are SYNCHRONOUS — an async callback makes
  // drizzle throw mid-restore and leaves a partially-moved sheet behind
  db.transaction((tx) => {
    for (const tabId of covered) {
      const prevRun = restore.get(tabId);
      tx.update(snapshots)
        .set({
          isBaseline: prevRun ? sql`(run_id = ${prevRun} AND trigger <> 'import')` : sql`0`,
        })
        .where(eq(snapshots.tabId, tabId))
        .run();
    }
  });

  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
  redirect(`/sheets/${spreadsheetId}`);
}

export async function updateSchedule(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(fd, "spreadsheetId");
  const kind = (str(fd, "kind") || "off") as ScheduleKind;

  const sheet = await requireOwnedSpreadsheet(id, user.id);

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
  const user = await requireUser();
  const spreadsheetId = str(fd, "spreadsheetId");
  const tabId = str(fd, "tabId");
  const key = str(fd, "keyColumn"); // "auto" | "0" | "1" ...
  await requireOwnedTab(tabId, user.id);
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
  const user = await requireUser();
  const id = str(fd, "spreadsheetId");
  await requireOwnedSpreadsheet(id, user.id);
  await db.delete(spreadsheets).where(eq(spreadsheets.id, id));
  revalidatePath("/");
  redirect("/");
}

/* ------------------------------------------------------------------ */
/* sharing                                                             */
/* ------------------------------------------------------------------ */

/** Grant viewer access (matched at Google sign-in by email) to ALL of the
 *  signed-in owner's sheets. */
export async function addMembers(fd: FormData): Promise<void> {
  const user = await requireUser();
  const emails = str(fd, "emails")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e !== (user.email ?? "").toLowerCase());
  for (const email of [...new Set(emails)]) {
    await db
      .insert(members)
      .values({ id: crypto.randomUUID(), ownerUserId: user.id, email, createdAt: Date.now() })
      .onConflictDoNothing();
  }
  revalidatePath("/", "layout"); // member list renders in the header on every page
}

export async function removeMember(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(fd, "id");
  await db.delete(members).where(and(eq(members.id, id), eq(members.ownerUserId, user.id)));
  revalidatePath("/", "layout");
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
  const user = await requireUser();
  const spreadsheetId = str(fd, "spreadsheetId");
  const body = str(fd, "body").trim();
  const del = str(fd, "delete") === "1";
  if (!body && !del) return;
  await requireSharedSpreadsheet(spreadsheetId, user);
  const tabId = str(fd, "tabId") || null;
  const runId = str(fd, "runId") || null;
  const rowKey = str(fd, "rowKey") || null;
  // never trust a client tabId: it must belong to THIS sheet
  let safeTabId = tabId;
  if (tabId) {
    const t = await db.select().from(tabs).where(eq(tabs.id, tabId));
    if (!t[0] || t[0].spreadsheetId !== spreadsheetId) safeTabId = null;
  }
  // editing a note = updating your own note at the same scope (no stacking)
  const scopeEquals = (n: typeof notesTable.$inferSelect) =>
    n.spreadsheetId === spreadsheetId &&
    (n.tabId ?? null) === safeTabId &&
    (n.runId ?? null) === runId &&
    (n.rowKey ?? null) === rowKey;
  const existing = (await db.select().from(notesTable).where(eq(notesTable.spreadsheetId, spreadsheetId)))
    .filter(scopeEquals)
    .filter((n) => n.authorUserId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (existing) {
    // an explicit delete always wins — the dialog's Delete button submits with
    // the note text still in the textarea, and an "empty body deletes" rule
    // alone turned that click into a silent re-save. An emptied body while
    // editing still removes the note (notes were otherwise permanent).
    if (del || !body) {
      await db.delete(notesTable).where(eq(notesTable.id, existing.id));
    } else {
      await db
        .update(notesTable)
        .set({ body: body.slice(0, 2000), createdAt: Date.now() })
        .where(eq(notesTable.id, existing.id));
    }
  } else if (!del) {
    // a delete with nothing to delete is a no-op — never an empty-body insert
    await db.insert(notesTable).values({
      id: crypto.randomUUID(),
      spreadsheetId,
      tabId: safeTabId,
      runId,
      rowKey,
      body: body.slice(0, 2000),
      authorUserId: user.id,
      createdAt: Date.now(),
    });
  }
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

/* ------------------------------------------------------------------ */
/* per-change sync acknowledgments                                     */
/* ------------------------------------------------------------------ */

export async function toggleAck(fd: FormData): Promise<void> {
  const user = await requireUser();
  const spreadsheetId = str(fd, "spreadsheetId");
  const tabId = str(fd, "tabId");
  const rowKey = str(fd, "rowKey");
  const on = str(fd, "on") === "1";
  await requireSharedTab(tabId, user);
  await setAck(tabId, rowKey, on);
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

/**
 * Ack every still-unresolved change on one tab in one shot — "entered the
 * whole batch downstream". The pending set is recomputed SERVER-side: the
 * rowKeys never round-trip through the client, so a tampered form cannot ack
 * rows the shared pending resolver (badge/CSV/digest) doesn't consider open.
 */
export async function ackAllUnentered(fd: FormData): Promise<void> {
  const user = await requireUser();
  const spreadsheetId = str(fd, "spreadsheetId");
  const tabId = str(fd, "tabId");
  const { tab } = await requireSharedTab(tabId, user);
  const pending = await getPendingChanges(tab);
  if (pending) {
    for (const row of pending.unresolved) {
      await setAck(tabId, row.rowKey, true);
    }
  }
  revalidatePath(`/sheets/${spreadsheetId}`);
  revalidatePath("/");
}

/* ------------------------------------------------------------------ */
/* digest settings                                                     */
/* ------------------------------------------------------------------ */

export async function saveDigestSettings(fd: FormData): Promise<void> {
  const userId = (await requireUser()).id;
  const raw = str(fd, "digestEmail").trim();
  // same shape rule as addMembers — a hostile string here becomes a nodemailer
  // recipient, and while header injection is blocked there, address-group
  // reinterpretation is not
  // strict shape: nodemailer reinterprets anything angle-bracket-ish as an
  // address group, delivering somewhere other than what was typed
  const email = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw) ? raw : "";
  // strict shapes: "99:99" would roll over inside usersDueForDigest, and a
  // non-numeric day would NaN-clamp to null (daily) — silently changing the
  // cadence the user asked for
  const timeRaw = str(fd, "digestTime");
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(timeRaw) ? timeRaw : "07:00";
  const dayRaw = str(fd, "digestDay"); // "daily" | "0".."6"
  const day = /^(daily|[0-6])$/.test(dayRaw) && dayRaw !== "daily" ? Number(dayRaw) : null;
  await db
    .update(users)
    .set({ digestEmail: email || null, digestTime: time, digestDay: day })
    .where(eq(users.id, userId));
  revalidatePath("/");
}

export async function savePushSettings(fd: FormData): Promise<void> {
  const userId = (await requireUser()).id;
  const raw = str(fd, "notifyUrl").trim();
  // strict shape: this URL becomes a fetch() target on every interesting
  // capture — only http(s) with a real topic path is stored
  const { isValidNotifyUrl } = await import("./notify");
  const url = isValidNotifyUrl(raw) ? raw : "";
  if (raw !== "" && url === "") {
    // an INVALID entry never clears what was saved before — the user keeps
    // their working topic and sees why this one was refused
    redirect("/settings?push=invalid");
  }
  await db
    .update(users)
    .set({ notifyUrl: url || null })
    .where(eq(users.id, userId));
  revalidatePath("/settings");
  revalidatePath("/");
}

/** Fire a real notification so the user can confirm their phone buzzes. */
export async function sendTestPush(_fd: FormData): Promise<void> {
  const user = await requireUser();
  if (!user.notifyUrl) redirect("/settings?push=none");
  const { sendPush } = await import("./notify");
  const ok = await sendPush(user.notifyUrl, {
    title: "SheetDiff",
    message: "Test notification — you're all set. Captures that introduce changes will buzz you here.",
    tag: "white_check_mark",
  });
  redirect(`/settings?push=${ok ? "sent" : "failed"}`);
}

/** Hide the getting-started checklist (it also hides itself when complete). */
export async function dismissOnboarding(_fd: FormData): Promise<void> {
  const userId = (await requireUser()).id;
  await db.update(users).set({ onboardingDismissedAt: Date.now() }).where(eq(users.id, userId));
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
  const userId = (await requireUser()).id;
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
    db.insert(snapshots)
      .values({
        id: crypto.randomUUID(),
        tabId,
        runId,
        trigger: "import",
        isBaseline: false,
        rowCount: data.rows.length,
        colCount: data.headers.length,
        dataBlob: encodeSnapshot(data),
        createdAt: now,
      })
      .run();
    stored++;
    if (!firstTabId) firstTabId = tabId;
  };

  if (parsed.kind === "csv") {
    const target =
      tracked.find((t) => t.id === str(fd, "tabId") && t.tracked) ?? tracked.find((t) => t.tracked) ?? null;
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
  redirect(
    `/sheets/${spreadsheetId}?tab=${encodeURIComponent(
      tracked.find((t) => t.id === firstTabId)?.title ?? "",
    )}&imported=${runId}`,
  );
}
