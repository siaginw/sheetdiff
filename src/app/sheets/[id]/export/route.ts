import { getSheetAccess } from "@/lib/access";
import { csvSafe } from "@/lib/csv";
import { db } from "@/lib/db";
import { notes as notesTable, tabs } from "@/lib/db/schema";
import { absoluteTime } from "@/lib/format";
import { getPendingChanges, pureCopyTabIds } from "@/lib/pending";
import { getSessionUser } from "@/lib/session";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import Papa from "papaparse";

export const runtime = "nodejs";

/**
 * CSV worklist of unresolved changes (since last collection, minus anything
 * already acknowledged as entered downstream) across every tracked tab —
 * the list of what still needs to be typed into the downstream system.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getSheetAccess(id, user);
  if (!access) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const sheet = access.sheet;

  const tracked = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, id))).filter((t) => t.tracked);
  if (tracked.length === 0) {
    return NextResponse.json({ error: "no tracked tabs" }, { status: 400 });
  }

  const sheetNotes = await db.select().from(notesTable).where(eq(notesTable.spreadsheetId, id));
  // a compilation tab's pending changes are echoes of the working tabs —
  // skip them or the typing list asks the office to enter the same shot twice
  // (the dashboard badge and the billing packet skip copies too)
  const copyTabIds = await pureCopyTabIds(await db.select().from(tabs).where(eq(tabs.spreadsheetId, id)));

  const rows: string[][] = [["Tab", "Change", "Row ID", "Row", "Column", "Old", "New", "Note", "Seen at"]];

  let dataAsOf = 0;
  for (const tab of tracked) {
    if (copyTabIds.has(tab.id)) continue;
    const pending = await getPendingChanges(tab);
    if (!pending) continue;
    dataAsOf = Math.max(dataAsOf, pending.latestAt);
    const when = absoluteTime(pending.latestAt);
    // rowKeys are only unique within a tab — scope notes accordingly
    const noteByRow = new Map(sheetNotes.filter((n) => n.rowKey && n.tabId === tab.id).map((n) => [n.rowKey!, n.body]));

    for (const row of pending.unresolved) {
      const note = noteByRow.get(row.rowKey) ?? "";

      if (row.status === "changed") {
        for (const c of row.cells) {
          rows.push([
            csvSafe(tab.title),
            "Changed",
            csvSafe(row.key ?? ""),
            String((row.newIndex ?? 0) + 1),
            csvSafe(c.header),
            csvSafe(c.from),
            csvSafe(c.to),
            csvSafe(note),
            when,
          ]);
        }
      } else if (row.status === "added") {
        rows.push([
          csvSafe(tab.title),
          "Added",
          csvSafe(row.key ?? ""),
          String((row.newIndex ?? 0) + 1),
          "(new row)",
          "",
          csvSafe(row.values.filter(Boolean).join(" | ")),
          csvSafe(note),
          when,
        ]);
      } else {
        rows.push([
          csvSafe(tab.title),
          "Removed",
          csvSafe(row.key ?? ""),
          String((row.oldIndex ?? 0) + 1),
          "(deleted row)",
          csvSafe(row.values.filter(Boolean).join(" | ")),
          "",
          csvSafe(note),
          when,
        ]);
      }
    }
  }

  // provenance stamps: every export names the DATA it came from and when
  // that data was captured — never the export moment, so the same data
  // exports to byte-identical files every time (audit diffing, idempotency)
  const stamp = [
    `# SheetDiff changes-to-enter — data as of ${new Date(dataAsOf || Date.now()).toISOString()}`,
    `# Sheet: ${csvSafe(sheet.title.replace(/[\r\n]+/g, " "))}`,
  ];
  const csv = stamp.join("\n") + "\n" + Papa.unparse(rows, { newline: "\n" });
  const safeTitle = sheet.title.replace(/[^\w.-]+/g, "-").slice(0, 40) || "sheet";
  const date = new Date(dataAsOf || Date.now()).toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sheetdiff-${safeTitle}-to-enter-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
