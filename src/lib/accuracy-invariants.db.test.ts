/**
 * ACCURACY INVARIANTS — the permanent cross-surface number-agreement net.
 *
 * This suite is the guarantee that every number SheetDiff shows about ONE
 * sheet agrees across EVERY surface that shows it. This product is used for
 * high-dollar accounting: if the dashboard badge says 6 and the billing CSV
 * says 5, someone invoices the wrong amount. Each test below computes the
 * expected value BY HAND from the seed data (documented inline, never by
 * calling the product's aggregation code), then reads the actual off each
 * surface:
 *
 *   surfaces: dashboard badge · sheet page (unentered count, tab pills,
 *   "Mark all entered", gap report, invoice ledger, Billing-day badge) ·
 *   worklist CSV · entry-queue CSV · billing CSV · billing page cards and
 *   sections · report page · digest.
 *
 * The ten invariants (numbered in the describe titles):
 *   1. to-enter count agrees everywhere (dashboard === sheet page === 3 CSVs
 *      === billing page === digest)
 *   2. placed-since-collection agrees (billing page === billing CSV === hand
 *      math: latest placed − baseline placed, deduped)
 *   3. report placed total === baseline placed + billing placed-since
 *   4. open-hole footage agrees (gap report === billing page === billing CSV)
 *   5. tab pill === per-tab pending resolver === "Mark all entered" count
 *   6. billable-now agrees (invoice ledger === billing card === billing
 *      section rows === sheet-page badge)
 *   7. the compilation (copy) tab never contributes to a deduped number
 *   8. acking ONE row drops every count surface by exactly 1
 *   9. "Mark as collected" drops every count surface to 0; dashboard says
 *      "up to date"
 *   10. undo restores the pre-collect state on every surface
 *
 * Same harness contract as the other *.db.test.ts suites: temp DATABASE_PATH
 * assigned at module scope before any db-dependent import (all dynamic),
 * session cookie genuinely signed, next/* modules mocked.
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

setupMigratedTempDb("accuracy");

const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { changeAcks, notes, snapshots, spreadsheets, tabs, users } = await import("@/lib/db/schema");
const { encodeSnapshot, toSnapshotData } = await import("@/lib/snapshots");
const { getPendingChanges } = await import("@/lib/pending");
const { buildDigestSheets } = await import("@/lib/digest");
const { setBaseline, toggleAck, undoBaseline } = await import("@/lib/actions");
const { default: Dashboard } = await import("@/app/page");
const { default: SheetPage } = await import("@/app/sheets/[id]/page");
const { default: BillingPage } = await import("@/app/sheets/[id]/billing/page");
const { default: ReportPage } = await import("@/app/sheets/[id]/report/page");
const { GET: worklistCsvGet } = await import("@/app/sheets/[id]/export/route");
const { GET: queueCsvGet } = await import("@/app/sheets/[id]/export/queue/route");
const { GET: billingCsvGet } = await import("@/app/sheets/[id]/export/billing/route");

/** the undo token invariant 9's collect captured — invariant 10 replays it */
let UNDO_TOKEN: string | null = null;

/* ------------------------------------------------------------------ */
/* seed                                                                */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;
// The anchors FLOAT: T2 trails real-now by a second so the billing surfaces'
// DATA clock (the latest snapshot) and the sheet page's live clock agree by
// construction — fixed historical anchors would drift apart as real time
// passes and flip the aging buckets these tests pin.
const T2 = Date.now() - 1_000; // run2 — latest, more changes
const T1 = T2 - 5 * DAY; // run1 — mid-window changes
const T0 = T2 - 10 * DAY; // run0 — the collected baseline

const SHEET = "acc-sheet";
const TAB_A = "acc-a"; // the working production tab
const TAB_B = "acc-b"; // the compilation tab: an exact copy of A's latest
const TAB_T = "acc-tot"; // TOTALS: designed/placed/permit columns

/** "M/D/YYYY" n days before the LATEST SNAPSHOT — the data clock every
 * aging surface reads, so the buckets stay deterministic forever. */
const dayStr = (daysAgo: number) => {
  const d = new Date(T2 - daysAgo * DAY);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
};
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
/** next month's run, pre-queued early — still owed, not missed */
const QUEUED_MONTH = MONTHS[(new Date().getMonth() + 1) % 12];
/** two months back — that invoice run has already happened */
const MISSED_MONTH = MONTHS[(new Date().getMonth() + 10) % 12];

// the working tab carries the office's own ledger vocabulary
const PE = ["Activity", "Start STA", "End STA", "Crew #", "Date Complete", "Bore Log in GIS?", "Entered in InEight", "Invoice #"];

// ---- the working tab's rows (hand-computable footage in the comments) ----
const B1 = (crew: string) => ["Plow", "0", "500", crew, dayStr(30), "y", dayStr(28), "1001"]; // 500 ft, keyed + invoiced 1001
const B2 = () => ["Plow", "500", "1000", "CREW A", dayStr(30), "y", dayStr(28), "1001"]; // 500 ft, keyed + invoiced 1001
const B3 = () => ["Bore", "1000", "1100", "CREW D", dayStr(45), "y", MISSED_MONTH, ""]; // 100 ft, keyed to a run that already happened
const B4 = () => ["Bore", "1100", "1200", "CREW D", dayStr(40), "y", QUEUED_MONTH, ""]; // 100 ft, pre-queued for next run
// completed, never keyed downstream, but the sub's log is NOT in GIS — the
// explicit "no" blocks billing; a 0–0 bore places no footage, so it shifts no
// placed/hole/pending number (data row 5 in the working tab)
const G1 = () => ["Bore", "0", "0", "CREW E", dayStr(2), "no", "", ""];
const M1 = () => ["Bore", "1200", "1500", "CREW B", dayStr(6), "y", "", ""]; // 300 ft NEW at run1 — billable now (aging office backlog)
const L1 = () => ["Bore", "1500", "1800", "CREW B", dayStr(1), "y", "", ""]; // 300 ft NEW at run2 — billable now (normal backlog)
const L2 = () => ["Plow", "1900", "2100", "CREW C", dayStr(20), "y", "", ""]; // 200 ft NEW at run2, backdated — billable + STUCK backlog; leaves hole 1800–1900
const L3 = () => ["GAP", "2300", "2400", "", "", "", "", ""]; // booked 100 ft gap; leaves hole 2100–2300 unaccounted
const L4 = () => ["Handhole", "2400", "2400", "CREW B", dayStr(1), "y", "", ""]; // structure on a station: no footage, no office work

const A_T0 = [B1("CREW A"), B2(), B3(), B4(), G1()];
const A_T1 = [B1("CREW A1"), B2(), B3(), B4(), G1(), M1()]; // the crew rename is the mid-window edit
const A_T2 = [B1("CREW A1"), B2(), B3(), B4(), G1(), M1(), L1(), L2(), L3(), L4()];
const B_T2 = A_T2.map((r) => [...r]); // the compilation tab: verbatim copy of the working tab

const TOT_HDR = ["Package", "Designed", "Placed", "Permit #"];
const T_T0 = [TOT_HDR, ["PE-4", "2000", "1200", "PERM-101"], ["PE-9", "1500", "0", ""]];
const T_T1 = [TOT_HDR, ["PE-4", "2000", "1500", "PERM-101"], ["PE-9", "1500", "0", ""]];
const T_T2 = [TOT_HDR, ["PE-4", "2000", "2000", "PERM-101"], ["PE-9", "1500", "0", ""]];

/* ------------------------------------------------------------------ */
/* hand-computed expectations — derived ONLY from the rows above        */
/* ------------------------------------------------------------------ */
const EXP = {
  /** baseline placed: 500 (B1) + 500 (B2) + 100 (B3) + 100 (B4) */
  placedBaselineFt: 1200,
  /** latest placed: baseline 1200 + 300 (M1) + 300 (L1) + 200 (L2); GAP and the
   *  handhole place nothing */
  placedLatestFt: 2000,
  /** latest − baseline, counted once (the copy tab re-lists every row) */
  placedSinceFt: 800,
  /** chain holes nobody booked: 1800–1900 (100) + 2100–2300 (200) */
  holesFt: 300,
  holeCount: 2,
  /** completed + GIS-checked + never keyed downstream: M1, L1, L2 — the
   *  GIS-"no" row (G1) is completed and unentered too, but GIS blocks it */
  billableRows: 3,
  billableFt: 800, // 300 + 300 + 200
  /** L2 is dated ~20 days before the snapshot it appeared in (tolerance 2) */
  lateEntries: 1,
  /** tab A rows changed/added since collection: B1's crew edit + M1, L1, L2,
   *  L3, L4 = 6, minus the seeded ack on B1's edit = 5; TOTALS' PE-4 "Placed"
   *  cell edit = 1; the copy tab has no collection point of its own = 0 */
  unenteredInitial: 6,
  /** after acking L1 (invariant 8): 6 − 1 */
  unenteredAfterOneAck: 5,
  /** per-tab pill on the working tab: 5 unresolved (B1's edit is acked) */
  pillA: 5,
  pillTotals: 1,
  officeBacklog: { stuck: 1, aging: 1, normal: 2 }, // L2 (~20d), M1 (~6d), L1 + the GIS-"no" row (~2d and ~1d)
  missedRuns: 1, // B3's month marker names a run that already happened
} as const;

/** row identity on the station tabs is the composite Activity·Start·End
 *  (no id column exists; the engine documents this identity for acks) */
const ROW_KEY_B1 = "plow·0·500";
const ROW_KEY_L1 = "bore·1500·1800";
const ROW_KEY_M1 = "bore·1200·1500";

beforeAll(async () => {
  state.userId = "owner";
  await db.insert(users).values({
    id: "owner", googleSub: "sub-owner", email: "owner@corp.com", name: "owner",
    tokensEnc: "unused", createdAt: 1,
  });
  await db.insert(spreadsheets).values({
    id: SHEET, userId: "owner", googleId: "gid-acc", title: "Accuracy Tracker",
    url: "https://docs.google.com/spreadsheets/d/gid-acc/edit",
    createdAt: 1, scheduleKind: "off", lastSnapshotAt: T2,
  });
  await db.insert(tabs).values([
    { id: TAB_A, spreadsheetId: SHEET, title: "A", position: 0, tracked: true },
    { id: TAB_B, spreadsheetId: SHEET, title: "B", position: 1, tracked: true },
    { id: TAB_T, spreadsheetId: SHEET, title: "TOTALS", position: 2, tracked: true },
  ]);

  const snap = (id: string, tabId: string, runId: string, isBaseline: boolean, createdAt: number, grid: string[][]) => {
    const data = toSnapshotData(grid);
    return {
      id, tabId, runId, trigger: "manual" as const, isBaseline,
      rowCount: data.rows.length, colCount: data.headers.length,
      dataBlob: encodeSnapshot(data), createdAt,
    };
  };
  await db.insert(snapshots).values([
    // run0 — the collected baseline (covers A and TOTALS)
    snap("acc-a0", TAB_A, "run0", true, T0, [PE, ...A_T0]),
    snap("acc-t0", TAB_T, "run0", true, T0, T_T0),
    // run1 — mid snapshot with changes; the copy tab appears as a verbatim
    // copy of A_T1 and carries ITS OWN collection point (mixed per-tab
    // baselines — the undo-corner shape)
    snap("acc-a1", TAB_A, "run1", false, T1, [PE, ...A_T1]),
    snap("acc-b1", TAB_B, "run1", true, T1, [PE, ...A_T1.map((r) => [...r])]),
    snap("acc-t1", TAB_T, "run1", false, T1, T_T1),
    // run2 — the latest, more changes; the copy tab re-copies A_T2 — its
    // pending (4 echoes) must appear on NO count surface
    snap("acc-a2", TAB_A, "run2", false, T2, [PE, ...A_T2]),
    snap("acc-b2", TAB_B, "run2", false, T2, [PE, ...B_T2]),
    snap("acc-t2", TAB_T, "run2", false, T2, T_T2),
  ]);

  // acks on some changes: B1's crew rename was already keyed downstream,
  // acked an hour after the mid capture that introduced it
  await db.insert(changeAcks).values({
    id: "acc-ack-1", tabId: TAB_A, rowKey: ROW_KEY_B1, ackedAt: T1 + 3_600_000,
  });

  // audit notes: one on a snapshot run, one on a pending row
  await db.insert(notes).values([
    { id: "acc-note-1", spreadsheetId: SHEET, tabId: TAB_A, runId: "run1", rowKey: null, body: "crew rename batch", authorUserId: "owner", createdAt: T1 + 60_000 },
    { id: "acc-note-2", spreadsheetId: SHEET, tabId: TAB_A, runId: null, rowKey: ROW_KEY_M1, body: "waiting on crew timesheet", authorUserId: "owner", createdAt: T1 + 120_000 },
  ]);
});

/* ------------------------------------------------------------------ */
/* surface readers                                                     */
/* ------------------------------------------------------------------ */

/** Collect every text node from a server-component element tree. Child
 *  components receive their DATA as props (a Row gets the BillingRow object),
 *  so plain objects are walked too. */
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

/** Visit the props of every element in a server-component tree (client
 *  components appear as unexecuted elements — their props ARE the surface). */
function walkProps(node: unknown, visit: (props: Record<string, unknown>) => void): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkProps(n, visit);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.props && typeof obj.props === "object") visit(obj.props as Record<string, unknown>);
  for (const v of Object.values(obj)) {
    if (v != null && typeof v === "object") walkProps(v, visit);
  }
}

/** A headline Card on the billing page, read by its label prop. */
function cardValue(el: unknown, label: string): string | undefined {
  let value: string | undefined;
  walkProps(el, (props) => {
    if (props.label === label && typeof props.value === "string") value = props.value;
  });
  return value;
}

/** Tab-pill badge counts, from each pill's title prop. */
function pillCounts(el: unknown): number[] {
  const out: number[] = [];
  walkProps(el, (props) => {
    if (typeof props.title === "string") {
      const m = /^(\d+) changes? to enter on this tab$/.exec(props.title);
      if (m) out.push(Number(m[1]));
    }
  });
  return out.sort((a, b) => a - b);
}

/** The sheet-wide count "Mark as collected" warns about (its prop). */
function collectedButtonState(el: unknown): { runId: string; isBaseline: boolean; unenteredCount: number } | null {
  let out: { runId: string; isBaseline: boolean; unenteredCount: number } | null = null;
  walkProps(el, (props) => {
    if (
      typeof props.unenteredCount === "number" &&
      typeof props.runId === "string" &&
      typeof props.isBaseline === "boolean" &&
      !out
    ) {
      out = { runId: props.runId, isBaseline: props.isBaseline, unenteredCount: props.unenteredCount };
    }
  });
  return out;
}

function unenteredCountProp(el: unknown): number | null {
  return collectedButtonState(el)?.unenteredCount ?? null;
}

/** The gap report handed to the sheet page's GapReportPanel. */
function gapReportProp(el: unknown): { placedFt: number; unaccounted: { from: number; to: number; ft: number }[] } | null {
  let report: { placedFt: number; unaccounted: { from: number; to: number; ft: number }[] } | null = null;
  walkProps(el, (props) => {
    const r = props.report as { placedFt?: number; unaccounted?: unknown } | undefined;
    if (r && typeof r.placedFt === "number" && Array.isArray(r.unaccounted) && !report) report = r as unknown as typeof report;
  });
  return report;
}

/** The invoice-ledger rollup handed to the sheet page's ProductionPanel. */
function invoicesProp(el: unknown): {
  billableNow: { row: number; activity: string; ft: number; daysSinceCompletion: number }[];
  billableFt: number;
  billedByInvoice: { invoice: string; rows: number }[];
  missedRun: { invoice: string; rows: number }[];
} | null {
  let inv: Record<string, unknown> | null = null;
  walkProps(el, (props) => {
    const i = props.invoices as Record<string, unknown> | undefined;
    if (i && Array.isArray(i.billableNow) && !inv) inv = i;
  });
  return inv as never;
}

/** The office-entry backlog handed to the sheet page's ProductionPanel. */
function officeProp(el: unknown): { stuck: unknown[]; aging: unknown[]; normal: unknown[]; enteredColumn: string | null } | null {
  let o: Record<string, unknown> | null = null;
  walkProps(el, (props) => {
    const p = props.office as Record<string, unknown> | undefined;
    if (p && Array.isArray(p.stuck) && !o) o = p;
  });
  return o as never;
}

/** What DiffView's "Mark all entered (N)" button will show — computed from
 *  the props the sheet page fed it, using DiffView's own documented formula
 *  (rows not unchanged/moved and not ack-resolved; search filters never
 *  shrink the batch). */
function markAllEnteredCount(el: unknown): number | null {
  let n: number | null = null;
  walkProps(el, (props) => {
    const result = props.result as { rows?: { status: string; rowKey: string }[] } | undefined;
    const resolved = props.resolvedRows as Record<string, boolean> | undefined;
    if (!result || !Array.isArray(result.rows) || !resolved) return;
    const count = result.rows.filter(
      (r) => r.status !== "unchanged" && r.status !== "moved" && resolved[r.rowKey] !== true,
    ).length;
    if (n === null) n = count;
  });
  return n;
}

async function csvBody(
  get: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
): Promise<string> {
  const res = await get(new Request("http://localhost/"), { params: Promise.resolve({ id: SHEET }) });
  expect(res.status).toBe(200);
  return res.text();
}

/** worklist CSV: one line per changed cell + one per added/removed row */
async function worklistDataLines(): Promise<number> {
  const body = await csvBody(worklistCsvGet);
  const lines = body.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  expect(lines[0]).toBe("Tab,Change,Row ID,Row,Column,Old,New,Note,Seen at");
  return lines.length - 1;
}

/** entry-queue CSV: one data row per pending shot (NEW/CHANGED/REMOVED),
 *  section header rows excluded */
async function queueDataRows(): Promise<number> {
  const body = await csvBody(queueCsvGet);
  return (body.match(/,(NEW|CHANGED|REMOVED),/g) ?? []).length;
}

async function billingCsvNumbers(): Promise<{ placedSince: number; holes: number; toEnter: number; late: number }> {
  const body = await csvBody(billingCsvGet);
  const m = /Placed since collection: ([\d,]+) ft \| Open holes: ([\d,]+) ft \| To enter: (\d+) \| Late entries: (\d+)/.exec(body);
  expect(m).not.toBeNull();
  return {
    placedSince: Number(m![1]!.replace(/,/g, "")),
    holes: Number(m![2]!.replace(/,/g, "")),
    toEnter: Number(m![3]!),
    late: Number(m![4]!),
  };
}

const renderSheet = (sp: Record<string, string> = {}) =>
  SheetPage({ params: Promise.resolve({ id: SHEET }), searchParams: Promise.resolve(sp) });
const renderBilling = () => BillingPage({ params: Promise.resolve({ id: SHEET }) });
const renderReport = () => ReportPage({ params: Promise.resolve({ id: SHEET }) });
const renderDashboard = () => Dashboard({ searchParams: Promise.resolve({}) });

async function digestUnresolved(): Promise<number> {
  const sheets = await buildDigestSheets("owner");
  const ours = sheets.find((s) => s.id === SHEET);
  expect(ours).toBeDefined();
  return ours!.unresolved;
}

/** every count surface, read fresh — the invariant-1 family */
async function allCountSurfaces(): Promise<Record<string, number>> {
  const dashboardText = pageText(await renderDashboard());
  const dash = /(\d+) to enter\b/.exec(dashboardText);
  const sheet = await renderSheet();
  return {
    dashboardBadge: dash ? Number(dash[1]) : -1,
    sheetPageUnentered: unenteredCountProp(sheet) ?? -1,
    worklistCsvRows: await worklistDataLines(),
    queueCsvRows: await queueDataRows(),
    billingCsvToEnter: (await billingCsvNumbers()).toEnter,
    billingPageToEnter: Number(cardValue(await renderBilling(), "to enter")),
    digestUnresolved: await digestUnresolved(),
  };
}

describe("temp-db harness", () => {
  it("runs against the temp database, never the dev database", () => {
    expect((db.$client as unknown as { name: string }).name).toBe(process.env.DATABASE_PATH);
  });
});

describe("invariants 1–7: one seeded sheet, every number agrees", () => {
  it("INVARIANT 1: to-enter count is the SAME number on every surface (expected 6, hand-computed)", async () => {
    const surfaces = await allCountSurfaces();
    // hand-computation (see EXP.unenteredInitial): working tab 5 (its crew-edit
    // is acked) + TOTALS 1 + copy tab 0
    expect(surfaces.dashboardBadge).toBe(EXP.unenteredInitial);
    expect(surfaces.sheetPageUnentered).toBe(EXP.unenteredInitial);
    expect(surfaces.worklistCsvRows).toBe(EXP.unenteredInitial);
    expect(surfaces.queueCsvRows).toBe(EXP.unenteredInitial);
    expect(surfaces.billingCsvToEnter).toBe(EXP.unenteredInitial);
    expect(surfaces.billingPageToEnter).toBe(EXP.unenteredInitial);
    expect(surfaces.digestUnresolved).toBe(EXP.unenteredInitial);
    // and the shared resolver agrees too (it feeds badge + CSVs + digest)
    const tabRow = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, SHEET))).find((t) => t.id === TAB_A)!;
    expect((await getPendingChanges(tabRow))!.counts.unresolved).toBe(EXP.pillA);
  });

  it("INVARIANT 2: placed-since-collection is 800 ft on the billing page, in the billing CSV, and by hand (2000 latest − 1200 baseline)", async () => {
    expect(EXP.placedLatestFt - EXP.placedBaselineFt).toBe(EXP.placedSinceFt); // the hand math itself
    const billing = await renderBilling();
    expect(cardValue(billing, "placed since collection")).toBe(`${EXP.placedSinceFt.toLocaleString("en-US")} ft`);
    const csv = await billingCsvNumbers();
    expect(csv.placedSince).toBe(EXP.placedSinceFt);
    expect(csv.late).toBe(EXP.lateEntries); // exactly the one backdated row (L2)
  });

  it("INVARIANT 3: report placed total (2,000 ft) === hand baseline (1,200) + billing placed-since (800)", async () => {
    const text = pageText(await renderReport());
    expect(text).toContain(`${EXP.placedLatestFt.toLocaleString("en-US")} ft`); // the report's "placed total" card
    const csv = await billingCsvNumbers();
    expect(EXP.placedLatestFt).toBe(EXP.placedBaselineFt + csv.placedSince);
    // the sheet page's own since-collection ledger shows the same 800
    expect(pageText(await renderSheet())).toContain(`+ ${EXP.placedSinceFt} ft since collection`);
  });

  it("INVARIANT 4: open-hole footage is 300 ft (2 holes) in the gap report, on the billing page, and in the billing CSV", async () => {
    const sheet = await renderSheet();
    const report = gapReportProp(sheet);
    expect(report).not.toBeNull();
    expect(report!.unaccounted.map((g) => g.ft).reduce((a, b) => a + b, 0)).toBe(EXP.holesFt);
    expect(report!.unaccounted).toHaveLength(EXP.holeCount);
    expect(report!.placedFt).toBe(EXP.placedLatestFt); // the gap report's own placed ledger

    const billing = await renderBilling();
    expect(cardValue(billing, "open holes")).toBe(EXP.holesFt.toLocaleString("en-US"));
    const billingText = pageText(billing);
    expect(billingText).toContain(`${EXP.holeCount} hole${(EXP.holeCount as number) === 1 ? "" : "s"}`);
    expect((billingText.match(/Unaccounted [\d,]+-[\d,]+/g) ?? []).length).toBe(EXP.holeCount);

    const csv = await billingCsvNumbers();
    expect(csv.holes).toBe(EXP.holesFt);
  });

  it("INVARIANT 5: tab pill (5) === per-tab pending resolver (5) === DiffView's \"Mark all entered\" count (5); pills sum to the sheet-wide count", async () => {
    const sheet = await renderSheet();
    const pills = pillCounts(sheet);
    expect(pills).toEqual([EXP.pillTotals, EXP.pillA]); // TOTALS: 1, working tab: 5

    const tabRow = (await db.select().from(tabs)).find((t) => t.id === TAB_A)!;
    const pending = await getPendingChanges(tabRow);
    expect(pending!.counts.unresolved).toBe(EXP.pillA);

    expect(markAllEnteredCount(sheet)).toBe(EXP.pillA);

    // pills + the quiet copy tab (0) sum to the sheet-wide unentered count
    expect(pills.reduce((a, b) => a + b, 0)).toBe(EXP.unenteredInitial);
    const collected = collectedButtonState(sheet);
    expect(collected).toEqual({ runId: "run2", isBaseline: false, unenteredCount: EXP.unenteredInitial });
  });

  it("INVARIANT 6: billable-now is 3 rows / 800 ft in the invoice ledger, the billing card, the billing section, and the sheet-page badge", async () => {
    const sheet = await renderSheet();
    const ledger = invoicesProp(sheet);
    expect(ledger).not.toBeNull();
    expect(ledger!.billableNow).toHaveLength(EXP.billableRows); // M1, L1, L2 — GIS "y", ledger blank
    expect(ledger!.billableFt).toBe(EXP.billableFt);
    expect(ledger!.billableNow.map((r) => r.row).sort((a, b) => a - b)).toEqual([6, 7, 8]); // data rows M1, L1, L2
    // the GIS gate excludes: data row 5 is completed + never keyed downstream,
    // exactly like the billable three, but its Bore Log says "no"
    expect(ledger!.billableNow.map((r) => r.row)).not.toContain(5);
    // the ledger's billed/queued/missed bookkeeping, straight off the sheet
    expect(ledger!.billedByInvoice).toContainEqual({ invoice: "1001", rows: 2 }); // B1 + B2
    expect(ledger!.billedByInvoice).toContainEqual({ invoice: `queued: ${QUEUED_MONTH}`, rows: 1 }); // B4
    expect(ledger!.missedRun).toEqual([{ invoice: MISSED_MONTH, rows: 1 }]); // B3

    const billing = await renderBilling();
    expect(cardValue(billing, "billable now")).toBe(`${EXP.billableRows} rows`);
    const billingText = pageText(billing);
    expect((billingText.match(/BILLABLE \d+d unentered/g) ?? []).length).toBe(EXP.billableRows);

    // the sheet page's Billing-day badge carries the same deduped count
    expect(pageText(sheet)).toMatch(new RegExp(`Billing day\\s+${EXP.billableRows}\\b`));

    // office backlog buckets land where their ages say (stuck/aging/normal)
    const office = officeProp(sheet);
    expect(office).not.toBeNull();
    expect(office!.stuck).toHaveLength(EXP.officeBacklog.stuck);
    expect(office!.aging).toHaveLength(EXP.officeBacklog.aging);
    expect(office!.normal).toHaveLength(EXP.officeBacklog.normal);
    expect(office!.enteredColumn).toBe("Entered in InEight");
  });

  it("INVARIANT 7: the copy tab NEVER contributes — every deduped number equals the working-tab-only computation", async () => {
    // placed-since would be 1,600 with the copy counted; it is 800
    const csv = await billingCsvNumbers();
    expect(csv.placedSince).toBe(EXP.placedSinceFt);
    const billingText = pageText(await renderBilling());
    expect(billingText).not.toContain((2 * EXP.placedSinceFt).toLocaleString("en-US"));
    // holes would be 600 ft / 4 holes with the copy counted
    expect(csv.holes).toBe(EXP.holesFt);
    expect(billingText).not.toContain("4 holes");
    expect(billingText).toContain("2 holes");
    // billable would be 6 rows with the copy counted
    expect(billingText).not.toContain("6 rows");
    // report placed total would be 4,000 ft with the copy counted
    const reportText = pageText(await renderReport());
    expect(reportText).toContain(`${EXP.placedLatestFt.toLocaleString("en-US")} ft`);
    expect(reportText).not.toContain(`${(2 * EXP.placedLatestFt).toLocaleString("en-US")} ft`);
    expect(reportText).toContain("10 copied rows counted once"); // all 10 of the copy's rows dropped
    // the sheet-page badge is the deduped sheet-wide billable count, not 6
    const sheetText = pageText(await renderSheet());
    expect(sheetText).not.toMatch(new RegExp(`Billing day\\s+${2 * EXP.billableRows}\\b`));
  });

  it("notes travel with the work: the row note lands in the CSV, the run note on the timeline", async () => {
    const body = await csvBody(worklistCsvGet);
    expect(body).toContain("waiting on crew timesheet"); // M1's Added line carries its note
    expect(pageText(await renderSheet())).toContain("crew rename batch");
  });

  it("re-exporting unchanged data is BYTE-IDENTICAL (idempotent, audit-diffable)", async () => {
    // every timestamp, age, and filename date rides the DATA clock — the
    // same snapshots must produce the same bytes on every export, forever
    for (const get of [worklistCsvGet, queueCsvGet, billingCsvGet]) {
      const a = await csvBody(get);
      const b = await csvBody(get);
      expect(a).toBe(b);
    }
  });

  it("CSV exports are LF-consistent end to end — no stray CR survives a machine re-parse", async () => {
    // the stamp lines were LF while Papa's data block was CRLF; re-parsing
    // left a trailing CR on the last field of every non-final row — on raw
    // sheet values like "15743 CR" in the entry queue
    for (const body of [await csvBody(worklistCsvGet), await csvBody(queueCsvGet), await csvBody(billingCsvGet)]) {
      expect(body).not.toContain(String.fromCharCode(13)); // stray CR
    }
  });
});

describe("invariant 8: ack ONE row — every count surface drops by exactly 1", () => {
  it("acking L1 (the user's toggleAck surface) moves every surface from 6 to 5", async () => {
    const before = await allCountSurfaces();
    expect(Object.values(before).every((n) => n === EXP.unenteredInitial)).toBe(true);

    const fd = new FormData();
    fd.set("spreadsheetId", SHEET);
    fd.set("tabId", TAB_A);
    fd.set("rowKey", ROW_KEY_L1);
    fd.set("on", "1");
    await toggleAck(fd);

    const after = await allCountSurfaces();
    for (const [surface, n] of Object.entries(after)) {
      expect(n, `${surface} dropped by exactly 1`).toBe(before[surface]! - 1);
    }
    expect(after.dashboardBadge).toBe(EXP.unenteredAfterOneAck);
    // the working tab's pill dropped too (5 -> 4); TOTALS is untouched (1)
    expect(pillCounts(await renderSheet())).toEqual([EXP.pillTotals, EXP.pillA - 1]);
  });
});

describe("invariant 9: \"Mark as collected\" — every count surface drops to 0; the dashboard says up to date", () => {
  it("collecting the latest run zeroes every count and shows the up-to-date state", async () => {
    const fd = new FormData();
    fd.set("spreadsheetId", SHEET);
    fd.set("runId", "run2");
    // redirects on success — mocked; CAPTURE the undo token it carries
    let redirectUrl = "";
    await setBaseline(fd).catch((e: unknown) => {
      const m = /^REDIRECT (.+)$/.exec(String((e as Error).message));
      if (m) redirectUrl = m[1]!;
    });
    expect(redirectUrl).toMatch(/collected=1/);
    UNDO_TOKEN = new URL(`http://x${redirectUrl}`).searchParams.get("undo");
    expect(UNDO_TOKEN).toBeTruthy(); // A/T were at run0, the copy at run1 — a real token

    const dashboardText = pageText(await renderDashboard());
    expect(dashboardText).toContain("up to date since collection");
    expect(dashboardText).not.toMatch(/\d+ to enter\b/);

    const sheet = await renderSheet();
    expect(unenteredCountProp(sheet)).toBe(0);
    expect(pageText(sheet)).not.toContain("to enter since collection");
    // the button flips to its "Collected here" state on the collected run
    expect(collectedButtonState(sheet)).toEqual({ runId: "run2", isBaseline: true, unenteredCount: 0 });
    expect(pillCounts(sheet)).toEqual([]);

    expect(await worklistDataLines()).toBe(0);
    const queueBody = await csvBody(queueCsvGet);
    expect(queueBody).toContain("Nothing pending — every tracked tab is quiet since its collection point.");
    expect((await billingCsvNumbers()).toEnter).toBe(0);
    expect(cardValue(await renderBilling(), "to enter")).toBe("0");
    expect(await digestUnresolved()).toBe(0);
  });
});

describe("invariant 10: undo restores the pre-collect state on every surface", () => {
  it("the REAL undo token restores every tab's exact prior collection point — mixed baselines included", async () => {
    // the banner the collect redirect lands on, carrying the token
    const banner = await renderSheet({ collected: "1", undo: UNDO_TOKEN! });
    const bannerText = pageText(banner);
    expect(bannerText).toContain("Collection point moved.");
    expect(bannerText).toContain("Undo — restore previous collection point");

    // undo through the real action. The mixed-baseline corner: A and TOTALS
    // were collected at run0 while the copy tab was collected at run1 — the
    // old single-run undo restored ONE of those and silently left the other
    // tabs collected, hiding un-entered work behind a success flash
    const fd = new FormData();
    fd.set("spreadsheetId", SHEET);
    fd.set("token", UNDO_TOKEN!);
    await undoBaseline(fd).catch(() => {});

    // every tab's baseline is EXACTLY where it was before the mark
    const baseIds = new Set(
      (
        await db
          .select({ id: snapshots.id })
          .from(snapshots)
          .where(and(inArray(snapshots.tabId, [TAB_A, TAB_B, TAB_T]), eq(snapshots.isBaseline, true)))
      ).map((r) => r.id),
    );
    expect(baseIds).toEqual(new Set(["acc-a0", "acc-b1", "acc-t0"]));

    const surfaces = await allCountSurfaces();
    // pre-collect state: 5 everywhere (6 minus invariant-8's ack, which an undo
    // must NOT discard — acks and collection points are different ledgers)
    for (const [surface, n] of Object.entries(surfaces)) {
      expect(n, `${surface} restored`).toBe(EXP.unenteredAfterOneAck);
    }
    expect(pageText(await renderDashboard())).toContain(`${EXP.unenteredAfterOneAck} to enter`);
    expect(pillCounts(await renderSheet())).toEqual([EXP.pillTotals, EXP.pillA - 1]);

    // the money numbers came back with it
    expect((await billingCsvNumbers()).placedSince).toBe(EXP.placedSinceFt);
    expect(cardValue(await renderBilling(), "placed since collection")).toBe(`${EXP.placedSinceFt.toLocaleString("en-US")} ft`);
    expect(pageText(await renderReport())).toContain(`${EXP.placedLatestFt.toLocaleString("en-US")} ft`);
    // and the collected banner is gone
    expect(pageText(await renderSheet())).not.toContain("Collection point moved.");
  });
});
