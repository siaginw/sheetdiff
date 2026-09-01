import { NextResponse } from "next/server";
import Papa from "papaparse";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabs } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSheetAccess } from "@/lib/access";
import { getPendingChanges, hasCollectedBaseline } from "@/lib/pending";
import { absoluteTime } from "@/lib/format";
import { csvSafe } from "@/lib/csv";

export const runtime = "nodejs";

/**
 * The ENTRY QUEUE — the typing list for the office system, shaped the way the
 * person keying it works: ONE ROW PER SHOT in the tab's own column order
 * (she re-keys rows, not cells), oldest introduction first so a stale backlog
 * surfaces at the top. Tabs with different column layouts become sections,
 * each with its own header row, ordered by the tab's oldest pending entry.
 * Removed rows stay summary-only — nothing to re-key; the worklist CSV
 * already spells those out cell by cell.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getSheetAccess(id, user);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });
  const sheet = access.sheet;

  const tracked = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, id))).filter((t) => t.tracked);
  if (tracked.length === 0) return NextResponse.json({ error: "no tracked tabs" }, { status: 400 });

  type Section = {
    tabTitle: string;
    oldestAt: number;
    header: string[];
    lines: string[][];
  };
  const sections: Section[] = [];
  let anyBaseline = false;
  let latestLabel = "unknown";
  let latestAtMs = 0;

  for (const tab of tracked) {
    const pending = await getPendingChanges(tab);
    if (!pending) {
      // null is ALSO the quiet-day short-circuit ("collected, nothing new
      // since") — a fully-acked quiet morning is a GOOD state and must not be
      // reported as a missing collection point. Only a tab with no collected
      // baseline at all keeps that message true.
      const collected = await hasCollectedBaseline(tab);
      if (collected) {
        anyBaseline = true;
        if (collected.latestAt > latestAtMs) {
          latestAtMs = collected.latestAt;
          latestLabel = absoluteTime(collected.latestAt);
        }
      }
      continue;
    }
    anyBaseline = true;
    if (pending.latestAt > latestAtMs) {
      latestAtMs = pending.latestAt;
      latestLabel = absoluteTime(pending.latestAt);
    }
    const header = ["Tab", "Status", "Changed columns", ...pending.diff.columns.map((c) => csvSafe(c.header))];
    // oldest first within the tab: the stale backlog leads
    const ordered = [...pending.unresolved].sort(
      (a, b) =>
        (pending.introducedAt.get(a.rowKey) ?? pending.latestAt) -
        (pending.introducedAt.get(b.rowKey) ?? pending.latestAt),
    );
    const sortedLines = ordered.map((row) => {
      if (row.status === "removed") {
        return [
          csvSafe(tab.title),
          "REMOVED",
          "",
          `DELETE IN OFFICE SYSTEM: ${csvSafe(row.values.filter(Boolean).join(" | ") || "(blank row)")}`,
        ];
      }
      const changedCols = row.status === "changed" ? row.cells.map((c) => c.header).join("|") : "";
      return [
        csvSafe(tab.title),
        row.status === "added" ? "NEW" : "CHANGED",
        csvSafe(changedCols),
        ...row.values.map((v) => csvSafe(v)),
      ];
    });
    sections.push({
      tabTitle: tab.title,
      oldestAt: ordered[0] ? pending.introducedAt.get(ordered[0].rowKey) ?? pending.latestAt : pending.latestAt,
      header,
      lines: sortedLines,
    });
  }

  if (!anyBaseline) {
    return new NextResponse("# No collection point yet — mark a snapshot as collected first.\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const stamp = [
    `# SheetDiff entry queue — one row per shot, oldest first — generated ${new Date().toISOString()}`,
    `# Snapshot: ${csvSafe(sheet.title.replace(/[\r\n]+/g, " "))} · ${latestLabel}`,
  ];

  // every tab quiet since its collection point: an honest EMPTY queue with a
  // stamp, not the no-collection-point message (the baseline is right there)
  if (sections.length === 0) {
    const csv = stamp.join("\n") + "\n# Nothing pending — every tracked tab is quiet since its collection point.\n";
    return new NextResponse(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // tabs ordered by their oldest pending entry
  sections.sort((a, b) => a.oldestAt - b.oldestAt);

  const table: string[][] = [];
  for (const s of sections) {
    table.push(s.header);
    table.push(...s.lines);
  }
  const csv = stamp.join("\n") + "\n" + Papa.unparse(table);
  const safeTitle = sheet.title.replace(/[^\w.-]+/g, "-").slice(0, 40) || "sheet";
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sheetdiff-${safeTitle}-entry-queue-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
