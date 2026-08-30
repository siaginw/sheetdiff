/**
 * FIELD VALIDATION (throwaway) — Agent 5, Refinement Fleet Pass 3.
 * Runs this pass's billing features against the real production tracker.
 * DELETE AFTER RUN. Never commit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { toSnapshotData } from "./snapshots";
import { buildBillingPacket, billingPacketCsv, entryLatency, verifiedStale, quietTabs } from "./billing";
import { detectLateEntries, agingGaps, parseCompletedDate, detectCrewColumn, detectActivityColumn } from "./production";
import { computeGapReport } from "./gaps";
import { diffSnapshots, computeIntroductionsDummy } from "./diff/engine";
import { isResolved } from "./sync";
import { norm } from "./diff/normalize";
import type { SnapshotData } from "./diff/engine";

const FILE = "C:/Users/Siagi/Downloads/Frost RT3a South Dakota Production Tracker.xlsx";
const NOW = new Date("2026-08-30T12:00:00").getTime(); // "today" per the file's newest data

function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellText(o.result);
    if ("text" in o && typeof o.text === "string") return o.text;
    if (Array.isArray(o.richText)) {
      return o.richText.map((t) => cellText((t as { text?: unknown }).text)).join("");
    }
    return "";
  }
  return String(v);
}

async function loadTable(name: string): Promise<SnapshotData> {
  const buf = fs.readFileSync(FILE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as never);
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`no sheet ${name}`);
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const vals: string[] = [];
    const r = row as unknown as { values: Record<number, unknown> };
    const max = Math.max(1, ...Object.keys(r.values ?? {}).map(Number).filter((n) => !isNaN(n)));
    for (let c = 1; c <= max; c++) vals.push(cellText(r.values?.[c]));
    grid.push(vals);
  });
  return toSnapshotData(grid);
}

const at = (ymd: string, h = 12) => new Date(`${ymd}T${String(h).padStart(2, "0")}:00:00`).getTime();
const DAY = 86_400_000;

/** Walk synthesis: rows appear in the sheet on their "Entered in InEight"
 *  date (the only per-row timeline the real file carries); rows completed but
 *  never entered appear completion+1d; undated rows exist from the start. */
function buildWalk(
  data: SnapshotData,
  days: string[],
  appearAt: (row: string[], i: number) => number,
): { createdAt: number; data: SnapshotData; finalIdx: number[] }[] {
  const times = days.map((d) => at(d));
  return times.map((t, k) => {
    const finalIdx: number[] = [];
    const rows: string[][] = [];
    data.rows.forEach((row, i) => {
      if (appearAt(row, i) <= t) {
        rows.push(row);
        finalIdx.push(i);
      }
    });
    return { createdAt: t, data: { headers: data.headers, rows }, finalIdx };
  });
}

function crewOfFactory(data: SnapshotData) {
  const crewCol = detectCrewColumn(data)!;
  return (row: string[]) => norm(row[crewCol]);
}

describe("M1 — buildBillingPacket on US2-PE-006 (messiest tab)", () => {
  it("assembles the packet from a real snapshot walk", async () => {
    const data = await loadTable("US2-PE-006");
    const appearAt = (row: string[]) => {
      const e = parseCompletedDate(row[17]);
      if (e) return at(e.toISOString().slice(0, 10));
      const c = parseCompletedDate(row[4]);
      if (c) return c.getTime() + DAY;
      return at("2026-08-18"); // undated GAP/placeholder rows: in from the start
    };
    const days: string[] = [];
    for (let d = new Date("2026-08-18"); d <= new Date("2026-08-30"); d = new Date(d.getTime() + DAY))
      days.push(d.toISOString().slice(0, 10));
    const walk = buildWalk(data, days, (row) => appearAt(row));

    // ---- aging gaps over the walk (real report sequence) ----
    const aged = agingGaps(
      walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })),
      NOW,
    );
    console.log("agingGaps:", aged.map((g) => `${Math.round(g.from)}-${Math.round(g.to)} ${g.ft}ft open ${g.daysOpen}d (first ${new Date(g.firstSeen).toISOString().slice(0, 10)})`));

    // ---- late entries over the walk ----
    const late = detectLateEntries(walk, 2);
    console.log("detectLateEntries:", late.map((e) => `row ${e.row} [${e.activity}] done ${e.completedOn} appeared ${new Date(e.appearedAt).toISOString().slice(0, 10)} ${e.daysLate}d late`));

    // ---- unresolved via the pending-resolver pattern (diff + introductions + acks) ----
    const baseline = walk.find((w) => w.createdAt === at("2026-08-21"))!; // last collection: Fri Aug 21
    const latest = walk[walk.length - 1]!;
    const diff = diffSnapshots(baseline.data, latest.data, {
      keyColumn: null,
      fromWhen: baseline.createdAt,
      toWhen: latest.createdAt,
    });
    const between = walk.filter((w) => w.createdAt > baseline.createdAt && w.createdAt <= latest.createdAt).reverse();
    const introducedAt = computeIntroductions(
      between.map((w) => ({ createdAt: w.createdAt, data: w.data })),
      diff.rows,
    );
    // office entered the 08-25 bore downstream the next morning; the 08-24
    // duplicate (comment: "duplicate entry - should be in PE-007") was NOT processed
    const ackMap = new Map<string, number>();
    for (const r of diff.rows) {
      if (r.status === "added" && r.values[1] === "8793") ackMap.set(r.rowKey, at("2026-08-26"));
    }
    const unresolved = diff.rows.filter(
      (r) => r.status !== "unchanged" && r.status !== "moved" && !isResolved(ackMap, r.rowKey, introducedAt.get(r.rowKey) ?? latest.createdAt),
    );
    console.log("unresolved:", unresolved.map((r) => `${r.status} [${r.values[0]}] ${r.values[1]}-${r.values[2]} "${r.values[14].slice(0, 40)}"`));

    // ---- placed footage since baseline: added chain rows' station math ----
    const stations = { start: 1, end: 2 };
    const sinceFt = unresolved
      .concat(diff.rows.filter((r) => r.status === "added")))
      .filter((r, i, a) => a.findIndex((x) => x.rowKey === r.rowKey) === i)
      .filter((r) => /(bore|plow|trench)/i.test(r.values[0] ?? ""))
      .reduce((n, r) => n + (Number(r.values[stations.end]) - Number(r.values[stations.start])), 0);

    const packet = buildBillingPacket({
      sinceFt,
      holes: aged,
      unresolved,
      lateEntries: late,
      snapshotLabel: "US2-PE-006 — Aug 30 12:00 PM",
      now: NOW,
    });
    console.log("\n===== BILLING PACKET (US2-PE-006) =====");
    console.log(billingPacketCsv(packet));
    console.log("===== counts:", JSON.stringify({ placedSinceFt: packet.placedSinceFt, openHoleFt: packet.openHoleFt, toEnterCount: packet.toEnterCount, lateCount: packet.lateCount }));

    expect(packet.placedSinceFt).toBeGreaterThan(0);
    expect(packet.openHoleFt).toBeGreaterThan(0);
  });
});

describe("M2 — billingPacketCsv round-trips comma / pipe / arrow through Papa.parse", () => {
  it("keeps every field parseable with hostile-but-realistic content", async () => {
    const data = await loadTable("US2-PE-006");
    const appearAt = (row: string[]) => {
      const e = parseCompletedDate(row[17]);
      if (e) return at(e.toISOString().slice(0, 10));
      const c = parseCompletedDate(row[4]);
      if (c) return c.getTime() + DAY;
      return at("2026-08-18");
    };
    const days: string[] = [];
    for (let d = new Date("2026-08-18"); d <= new Date("2026-08-30"); d = new Date(d.getTime() + DAY))
      days.push(d.toISOString().slice(0, 10));
    const walk = buildWalk(data, days, (row) => appearAt(row));
    const aged = agingGaps(walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })), NOW);
    const late = detectLateEntries(walk, 2);

    // a CHANGED row (arrow detail) — synthetic edit on a real row: Invoice # filled in
    const baseRow = data.rows.find((r) => norm(r[0]) === "Bore" && norm(r[1]) === "38254")!;
    const changedRow = baseRow.slice();
    changedRow[18] = "3103";
    const changedDiffRow = {
      status: "changed" as const,
      key: null,
      rowKey: "k1",
      oldIndex: 10,
      newIndex: 10,
      movedFrom: null,
      cells: [{ col: 18, header: "Invoice #", from: "", to: "3103" }],
      values: changedRow,
    };
    // a NEW row whose crew contains a pipe (mission case) — real row values, hostile crew cell
    const pipeCrewRow = baseRow.slice();
    pipeCrewRow[5] = "HAIDER 1|2";
    const addedDiffRow = {
      status: "added" as const,
      key: null,
      rowKey: "k2",
      oldIndex: null,
      newIndex: 11,
      movedFrom: null,
      cells: [],
      values: pipeCrewRow,
    };

    const packet = buildBillingPacket({
      sinceFt: 768,
      holes: aged,
      unresolved: [changedDiffRow, addedDiffRow],
      lateEntries: late,
      snapshotLabel: 'Frost RT3a, South Dakota — "Aug 30" 12:00 PM', // comma + quotes in the label
      now: NOW,
    });
    const csv = billingPacketCsv(packet);
    console.log("\n===== CSV under test =====\n" + csv);

    const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: "greedy" });
    expect(parsed.errors).toEqual([]);
    const dataRows = parsed.data.filter((r) => !r[0]!.startsWith("#"));
    expect(dataRows.every((r) => r.length === 4)).toBe(true); // Kind,Detail,Ft,Note

    const arrowRow = dataRows.find((r) => r[1]!.includes("->"));
    expect(arrowRow).toBeDefined();
    expect(arrowRow![1]).toContain("Invoice #:  -> 3103");

    const pipeRow = dataRows.find((r) => r[1]!.includes("HAIDER 1|2"));
    expect(pipeRow).toBeDefined();
    expect(pipeRow![1]).toContain(" | ");

    const lateRow = dataRows.find((r) => r[0] === "late");
    expect(lateRow).toBeDefined();
    expect(lateRow![1]).toMatch(/Row \d+ \(Bore\) dated 2026-08-21, entered 3d late/); // comma inside detail

    // snapshot label with comma must survive in the provenance header
    expect(csv.split("\n")[1]).toContain("# Snapshot: Frost RT3a, South Dakota");
  });
});

describe("M3 — entryLatency crew misattribution on US1-PE-009 (real two-crew Bore days)", () => {
  it("attributes late entries to the first matching activity row, not the actual crew", async () => {
    const data = await loadTable("US1-PE-009");
    const days: string[] = [];
    for (let d = new Date("2026-06-23"); d <= new Date("2026-08-08"); d = new Date(d.getTime() + DAY))
      days.push(d.toISOString().slice(0, 10));
    const walk = buildWalk(
      data,
      days,
      (row) => {
        const e = parseCompletedDate(row[17]);
        if (e) return at(e.toISOString().slice(0, 10));
        const c = parseCompletedDate(row[4]);
        if (c) return c.getTime() + DAY;
        return at("2026-06-23");
      },
    );
    const latest = walk[walk.length - 1]!;
    const late = detectLateEntries(walk, 2);
    console.log(`late entries flagged: ${late.length}`);
    console.log(late.slice(0, 12).map((e) => `  row ${e.row} [${e.activity}] done ${e.completedOn} appeared ${new Date(e.appearedAt).toISOString().slice(0, 10)} ${e.daysLate}d`).join("\n"));

    const crewOf = crewOfFactory(data);
    const produced = entryLatency(
      late.map((e) => ({ activity: e.activity, daysLate: e.daysLate })),
      latest.data,
      crewOf,
    );

    // ground truth: map each late entry back to its actual final-grid row via the walk
    const walkAt = new Map(walk.map((w) => [w.createdAt, w.finalIdx]));
    const crewCol = detectCrewColumn(data)!;
    const truth = new Map<string, number[]>();
    for (const e of late) {
      const w = walk.find((x) => x.createdAt === e.appearedAt)!;
      const finalI = w.finalIdx[e.row - 1]!;
      const crew = norm(data.rows[finalI]![crewCol]) || "(no crew)";
      truth.set(crew, [...(truth.get(crew) ?? []), e.daysLate]);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const truthBoard = [...truth.entries()]
      .map(([crew, ds]) => ({ crew, medianDays: median(ds), entries: ds.length, worstDays: Math.max(...ds) }))
      .sort((a, b) => b.medianDays - a.medianDays);

    console.log("\nproduced leaderboard:", JSON.stringify(produced));
    console.log("ground-truth leaderboard:", JSON.stringify(truthBoard));

    // the misattribution, concretely
    const prodIvans = produced.find((c) => /IVANS/i.test(c.crew));
    const trueHaider = truthBoard.find((c) => /HAIDER/i.test(c.crew));
    const prodHaider = produced.find((c) => /HAIDER/i.test(c.crew));
    console.log(
      `\nIVANS: produced ${prodIvans?.entries} entries (median ${prodIvans?.medianDays}d) vs truth ${truthBoard.find((c) => /IVANS/i.test(c.crew))?.entries} (median ${truthBoard.find((c) => /IVANS/i.test(c.crew))?.medianDays}d)`,
    );
    console.log(`HAIDER 1: produced ${prodHaider?.entries ?? "ABSENT"} entries vs truth ${trueHaider?.entries} (median ${trueHaider?.medianDays}d)`);

    // every late Bore entry lands on the FIRST Bore row in the sheet (crew IVANS, idx9)
    const firstBoreCrew = crewOf(data.rows.find((r) => norm(r[0]) === "Bore")!);
    const allLateOnOneCrew = produced.length === 1 && /IVANS/i.test(produced[0]!.crew);
    console.log(`first Bore row in sheet belongs to: ${firstBoreCrew} -> ALL late entries attributed there: ${allLateOnOneCrew}`);

    // zoom: 2026-07-13 — IVANS AND HAIDER 1 both did Bore; all four rows entered 07-17 (4d late)
    const dayLate = late.filter((e) => e.completedOn === "2026-07-13" || e.completedOn === "2026-07-14");
    const dayProduced = entryLatency(
      dayLate.map((e) => ({ activity: e.activity, daysLate: e.daysLate })),
      latest.data,
      crewOf,
    );
    const dayTruth = new Map<string, number>();
    for (const e of dayLate) {
      const w = walk.find((x) => x.createdAt === e.appearedAt)!;
      const finalI = w.finalIdx[e.row - 1]!;
      const crew = norm(data.rows[finalI]![crewCol]);
      dayTruth.set(crew, (dayTruth.get(crew) ?? 0) + 1);
    }
    console.log(`\n2026-07-13/14 zoom: produced ${JSON.stringify(dayProduced.map((c) => ({ crew: c.crew, entries: c.entries })))} vs truth ${JSON.stringify([...dayTruth.entries()])}`);

    expect(allLateOnOneCrew).toBe(true); // heuristic collapses everything onto one crew
    expect(prodHaider).toBeUndefined(); // HAIDER 1 never appears despite 5+ late bores
    expect(truthBoard.length).toBeGreaterThan(1); // truth has multiple crews
  });
});

describe("M5 — which features fire on this file today", () => {
  it("verifiedStale on US2-PE-007 walk: how many rows get flagged", async () => {
    const data = await loadTable("US2-PE-007");
    const days: string[] = [];
    for (let d = new Date("2026-08-15"); d <= new Date("2026-08-30"); d = new Date(d.getTime() + DAY))
      days.push(d.toISOString().slice(0, 10));
    const walk = buildWalk(
      data,
      days,
      (row) => {
        const e = parseCompletedDate(row[17]);
        if (e) return at(e.toISOString().slice(0, 10));
        const c = parseCompletedDate(row[4]);
        if (c) return c.getTime() + DAY;
        return at("2026-08-15");
      },
    );
    // rowChangedAt: last snapshot in which the row's content appeared/changed
    const { rowContentKey } = await import("./diff/engine");
    const rowChangedAt = new Map<string, number>();
    const seenAt = new Map<string, number>();
    for (const w of walk) {
      for (const row of w.data.rows) {
        const k = rowContentKey(row);
        if (!seenAt.has(k)) seenAt.set(k, w.createdAt);
        rowChangedAt.set(k, w.createdAt); // rows never edited: changedAt = first appearance
      }
    }
    const stale = verifiedStale(walk[walk.length - 1]!.data, rowChangedAt, NOW);
    const verifiedCol = walk[walk.length - 1]!.data.headers.findIndex((h) => /verified\s*by/i.test(norm(h)));
    const verifiedRows = walk[walk.length - 1]!.data.rows.filter((r) => norm(r[verifiedCol]) !== "").length;
    console.log(`verifiedStale: ${stale.length} flagged of ${verifiedRows} rows carrying "${norm(walk[walk.length - 1]!.data.headers[verifiedCol])}" initials`);
    console.log(`  sample: ${JSON.stringify(stale.slice(0, 3))}`);
    expect(stale.length).toBeGreaterThan(0);
  });

  it("quietTabs across all PE tabs with real last-row dates", async () => {
    const buf = fs.readFileSync(FILE);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as never);
    const tabs: { title: string; lastNewRowAt: number | null }[] = [];
    for (const ws of wb.worksheets) {
      if (!/PE-\d+$/.test(ws.name)) continue;
      const grid: string[][] = [];
      ws.eachRow((row) => {
        const vals: string[] = [];
        const r = row as unknown as { values: Record<number, unknown> };
        const max = Math.max(1, ...Object.keys(r.values ?? {}).map(Number).filter((n) => !isNaN(n)));
        for (let c = 1; c <= max; c++) vals.push(cellText(r.values?.[c]));
        grid.push(vals);
      });
      const data = toSnapshotData(grid);
      let last: number | null = null;
      for (const row of data.rows) {
        const c = parseCompletedDate(row[4]);
        if (c) last = Math.max(last ?? 0, c.getTime());
      }
      tabs.push({ title: ws.name, lastNewRowAt: last });
    }
    const quiet = quietTabs(tabs, NOW, 5);
    console.log(`quietTabs(5d): ${quiet.length}/${tabs.length} tabs flagged`);
    console.log(quiet.map((t) => `  ${t.title}: ${t.days}d quiet`).join("\n"));
    const active = tabs.filter((t) => !quiet.some((q) => q.title === t.title) && t.lastNewRowAt !== null);
    console.log(`still active: ${active.map((t) => `${t.title} (${Math.floor((NOW - t.lastNewRowAt!) / DAY)}d)`).join(", ")}`);
    expect(quiet.length).toBeGreaterThan(0);
  });
});
