/**
 * FIELD VALIDATION (throwaway) — Agent 5, Refinement Fleet Pass 3.
 * Runs this pass's billing features against the real production tracker.
 * DELETE AFTER RUN. Never commit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { toSnapshotData } from "./snapshots";
import { buildBillingPacket, billingPacketCsv, entryLatency, verifiedStale, quietTabs } from "./billing";
import { detectLateEntries, agingGaps, parseCompletedDate, detectCrewColumn } from "./production";
import { computeGapReport } from "./gaps";
import { diffSnapshots, rowContentKey, detectKeyColumn, detectCompositeKey } from "./diff/engine";
import { compositeKey, norm } from "./diff/normalize";
import type { SnapshotData } from "./diff/engine";

// ./sync imports ./db — point it at a throwaway file BEFORE the dynamic import
// (vitest hoists static imports, so this must be dynamic — see actions.db.test.ts)
process.env.DATABASE_PATH = path.join(os.tmpdir(), `sd-field-scratch-${process.pid}.db`);

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
  return times.map((t) => {
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

function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = new Date(from); d <= new Date(to); d = new Date(d.getTime() + DAY))
    days.push(d.toISOString().slice(0, 10));
  return days;
}

async function peWalk(tab: string, from: string, to: string) {
  const data = await loadTable(tab);
  const walk = buildWalk(
    data,
    dayRange(from, to),
    (row: string[]) => {
      const e = parseCompletedDate(row[17]);
      if (e) return at(e.toISOString().slice(0, 10));
      const c = parseCompletedDate(row[4]);
      if (c) return c.getTime() + DAY;
      return at(from);
    },
  );
  return { data, walk };
}

describe("M1 — buildBillingPacket on US2-PE-006 (messiest tab)", () => {
  it("assembles the packet from a real snapshot walk", async () => {
    const { walk } = await peWalk("US2-PE-006", "2026-08-18", "2026-08-30");

    // ---- aging gaps over the walk (real report sequence) ----
    const aged = agingGaps(
      walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })),
      NOW,
    );
    console.log(
      "agingGaps:",
      aged.map(
        (g) =>
          `${Math.round(g.from)}-${Math.round(g.to)} ${g.ft}ft open ${g.daysOpen}d (first seen ${new Date(g.firstSeen).toISOString().slice(0, 10)})`,
      ),
    );

    // ---- late entries over the walk ----
    const late = detectLateEntries(walk, 2);
    console.log(
      "detectLateEntries:",
      late.map(
        (e) =>
          `row ${e.row} [${e.activity}] done ${e.completedOn} appeared ${new Date(e.appearedAt).toISOString().slice(0, 10)} ${e.daysLate}d late`,
      ),
    );

    // ---- unresolved via the pending-resolver pattern (diff + introductions + acks) ----
    const baseline = walk.find((w) => w.createdAt === at("2026-08-21"))!; // last collection: Fri Aug 21
    const latest = walk[walk.length - 1]!;
    const diff = diffSnapshots(baseline.data, latest.data, {
      keyColumn: null,
      fromWhen: baseline.createdAt,
      toWhen: latest.createdAt,
    });
    console.log("diff.summary:", JSON.stringify(diff.summary));
    console.log(`baseline rows=${baseline.data.rows.length} latest rows=${latest.data.rows.length}`);

    // what keying did the engine pick, and how many rows have a BLANK key?
    const keyCol = detectKeyColumn(latest.data);
    const compCols = detectCompositeKey(latest.data);
    console.log(`detectKeyColumn -> ${keyCol} (${keyCol !== null ? latest.data.headers[keyCol] : "-"}); detectCompositeKey -> ${JSON.stringify(compCols)}`);
    const blankKey = (row: string[]) =>
      keyCol !== null ? norm(row[keyCol]) === "" : compCols ? compositeKey(row, compCols) === "" : false;
    console.log(
      `blank-key rows: baseline=${baseline.data.rows.filter(blankKey).length}/${baseline.data.rows.length} latest=${latest.data.rows.filter(blankKey).length}/${latest.data.rows.length}`,
    );

    const byStatus = new Map<string, number>();
    for (const r of diff.rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    console.log("diff rows by status:", JSON.stringify([...byStatus]));

    const between = walk
      .filter((w) => w.createdAt > baseline.createdAt && w.createdAt <= latest.createdAt)
      .reverse();
    const { computeIntroductions, isResolved } = await import("./sync");
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
      (r) =>
        r.status !== "unchanged" &&
        r.status !== "moved" &&
        !isResolved(ackMap, r.rowKey, introducedAt.get(r.rowKey) ?? latest.createdAt),
    );
    const unresolvedByStatus = new Map<string, number>();
    for (const r of unresolved) unresolvedByStatus.set(r.status, (unresolvedByStatus.get(r.status) ?? 0) + 1);
    const realRows = unresolved.filter((r) => r.values.slice(0, 3).some((v) => v !== ""));
    console.log(`unresolved=${unresolved.length} by status=${JSON.stringify([...unresolvedByStatus])}`);
    console.log(
      `unresolved with real Activity/STA content=${realRows.length}: ${realRows.map((r) => `${r.status} [${r.values[0]}] ${r.values[1]}-${r.values[2]} "${(r.values[14] ?? "").slice(0, 45)}"`)}`,
    );

    // ---- placed footage since baseline: added chain rows' station math ----
    const addedRows = diff.rows.filter((r) => r.status === "added" && r.values.slice(0, 3).some((v) => v !== ""));
    const sinceFt = addedRows
      .filter((r) => /(bore|plow|trench)/i.test(r.values[0] ?? ""))
      .reduce((n, r) => n + (Number(r.values[2]) - Number(r.values[1])), 0);
    console.log(
      `real rows added since baseline: ${addedRows.map((r) => `${r.values[0]} ${r.values[1]}-${r.values[2]} (${Number(r.values[2]) - Number(r.values[1])}ft)`)} -> sinceFt=${sinceFt}`,
    );

    // ---- packet as the app would build it (all unresolved, phantoms included) ----
    const packet = buildBillingPacket({
      sinceFt,
      holes: aged,
      unresolved,
      lateEntries: late,
      snapshotLabel: "US2-PE-006 — Aug 30 12:00 PM",
      now: NOW,
    });
    console.log("\n===== BILLING PACKET (US2-PE-006), as-shipped inputs =====");
    console.log(billingPacketCsv(packet).split("\n").slice(0, 6).join("\n") + `\n... (${packet.rows.length} rows total)`);
    console.log(
      "counts:",
      JSON.stringify({
        placedSinceFt: packet.placedSinceFt,
        openHoleFt: packet.openHoleFt,
        toEnterCount: packet.toEnterCount,
        lateCount: packet.lateCount,
      }),
    );

    // ---- the packet the office manager SHOULD get (phantoms excluded) ----
    const cleanPacket = buildBillingPacket({
      sinceFt,
      holes: aged,
      unresolved: realRows,
      lateEntries: late,
      snapshotLabel: "US2-PE-006 — Aug 30 12:00 PM",
      now: NOW,
    });
    console.log("\n===== BILLING PACKET (US2-PE-006), phantom blank rows excluded =====");
    console.log(billingPacketCsv(cleanPacket));

    expect(packet.placedSinceFt).toBe(768);
    expect(packet.openHoleFt).toBe(28086);
  });
});

describe("M2 — billingPacketCsv round-trips comma / pipe / arrow through Papa.parse", () => {
  it("keeps every field parseable with hostile-but-realistic content", async () => {
    const { walk } = await peWalk("US2-PE-006", "2026-08-18", "2026-08-30");
    const aged = agingGaps(walk.map((w) => ({ createdAt: w.createdAt, report: computeGapReport(w.data) })), NOW);
    const late = detectLateEntries(walk, 2);

    // a CHANGED row (arrow detail) — synthetic edit on a real row: Invoice # filled in
    const rows = (await loadTable("US2-PE-006")).rows;
    const baseRow = rows.find((r) => norm(r[0]) === "Bore" && norm(r[1]) === "38254")!;
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
    console.log("\n===== CSV under test (JSON-escaped lines) =====");
    for (const line of csv.split("\n")) console.log(JSON.stringify(line));

    const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: "greedy" });
    console.log("Papa errors:", JSON.stringify(parsed.errors));
    const dataRows = parsed.data.filter((r) => !r[0]!.startsWith("#"));
    const badWidth = dataRows.filter((r) => r.length !== 4);
    console.log(
      `field-width check: ${dataRows.length - badWidth.length}/${dataRows.length} data rows have exactly 4 fields` +
        (badWidth.length ? ` — BROKEN ROWS: ${badWidth.map((r) => JSON.stringify(r)).join(" ; ")}` : ""),
    );

    const arrowRow = dataRows.find((r) => r[1]!.includes("->"));
    const pipeRow = dataRows.find((r) => r[1]!.includes("HAIDER 1|2"));
    const lateRow = dataRows.find((r) => r[0] === "late");
    console.log("arrow survives:", JSON.stringify(arrowRow?.[1]));
    console.log("pipe survives:", JSON.stringify(pipeRow?.[1]));
    console.log("late row fields:", JSON.stringify(lateRow));

    expect(parsed.errors).toEqual([]);
    expect(dataRows.every((r) => r.length === 4)).toBe(true); // fails while commas don't trigger quoting
    expect(arrowRow![1]).toContain("Invoice #:  -> 3103");
    expect(pipeRow![1]).toContain(" | ");
    expect(lateRow![1]).toMatch(/Row \d+ \(Bore\) dated 2026-08-21, entered 3d late/);
    expect(csv.split("\n")[1]).toContain("# Snapshot: Frost RT3a, South Dakota");
  });
});

describe("M3 — entryLatency crew misattribution on US1-PE-009 (real two-crew Bore days)", () => {
  it("attributes late entries to the first row matching the ACTIVITY, not the actual crew", async () => {
    const { data, walk } = await peWalk("US1-PE-009", "2026-06-23", "2026-08-08");
    const latest = walk[walk.length - 1]!;
    const late = detectLateEntries(walk, 2);
    const byActivity = new Map<string, number>();
    for (const e of late) byActivity.set(e.activity, (byActivity.get(e.activity) ?? 0) + 1);
    console.log(`late entries flagged: ${late.length} by activity: ${JSON.stringify([...byActivity])}`);

    const crewOf = crewOfFactory(data);
    const produced = entryLatency(
      late.map((e) => ({ activity: e.activity, daysLate: e.daysLate })),
      latest.data,
      crewOf,
    );

    // ground truth: map each late entry back to its actual final-grid row via the walk
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

    const trueIvans = truthBoard.find((c) => /IVANS/i.test(c.crew))!;
    const prodIvans = produced.find((c) => /IVANS/i.test(c.crew))!;
    const trueHaider = truthBoard.find((c) => /HAIDER/i.test(c.crew))!;
    const prodHaider = produced.find((c) => /HAIDER/i.test(c.crew));
    console.log(
      `\nIVANS: produced ${prodIvans.entries} entries (median ${prodIvans.medianDays}d) vs truth ${trueIvans.entries} (median ${trueIvans.medianDays}d)`,
    );
    console.log(`HAIDER 1: produced ${prodHaider?.entries ?? "ABSENT"} entries vs truth ${trueHaider.entries} (median ${trueHaider.medianDays}d)`);

    // zoom: 2026-07-13/14 — IVANS AND HAIDER 1 both did Bore; all rows entered 4d late
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
    console.log(
      `\n2026-07-13/14 zoom: produced ${JSON.stringify(dayProduced.map((c) => ({ crew: c.crew, entries: c.entries })))} vs truth ${JSON.stringify([...dayTruth.entries()])}`,
    );

    expect(prodHaider).toBeUndefined(); // HAIDER 1 never appears despite 4 late bores
    expect(prodIvans.entries).toBeGreaterThan(trueIvans.entries); // IVANS absorbs HAIDER 1's lateness
    expect(dayProduced.find((c) => /HAIDER/i.test(c.crew))).toBeUndefined();
    expect(truthBoard.length).toBeGreaterThan(1); // truth has multiple crews
  });
});

describe("M5 — which features fire on this file today", () => {
  it("verifiedStale on US2-PE-007 walk: how many rows get flagged", async () => {
    const { walk } = await peWalk("US2-PE-007", "2026-08-15", "2026-08-30");
    const lastData = walk[walk.length - 1]!.data;
    // rowChangedAt: when each row's current content first appeared in the walk
    const rowChangedAt = new Map<string, number>();
    for (const w of walk) {
      for (const row of w.data.rows) {
        const k = rowContentKey(row);
        if (!rowChangedAt.has(k)) rowChangedAt.set(k, w.createdAt);
      }
    }
    const stale = verifiedStale(lastData, rowChangedAt, NOW);
    const verifiedCol = lastData.headers.findIndex((h) => /verified\s*by/i.test(norm(h)));
    const verifiedRows = lastData.rows.filter((r) => norm(r[verifiedCol]) !== "").length;
    console.log(
      `verifiedStale: ${stale.length} flagged of ${verifiedRows} rows carrying "${norm(lastData.headers[verifiedCol])}" initials`,
    );
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
