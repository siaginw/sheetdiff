import { NextResponse } from "next/server";
import Papa from "papaparse";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabs, notes as notesTable } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSheetAccess } from "@/lib/access";
import { getPendingChanges } from "@/lib/pending";
import { absoluteTime } from "@/lib/format";
import { csvSafe } from "@/lib/csv";

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

  const rows: string[][] = [
    ["Tab", "Change", "Row ID", "Row", "Column", "Old", "New", "Note", "Seen at"],
  ];

  for (const tab of tracked) {
    const pending = await getPendingChanges(tab);
    if (!pending) continue;
    const when = absoluteTime(pending.latestAt);
    // rowKeys are only unique within a tab — scope notes accordingly
    const noteByRow = new Map(
      sheetNotes
        .filter((n) => n.rowKey && n.tabId === tab.id)
        .map((n) => [n.rowKey!, n.body]),
    );

    for (const row of pending.unresolved) {
      const note = noteByRow.get(row.rowKey) ?? "";

      if (row.status === "changed") {
        for (const c of row.cells) {
          rows.push([
            csvSafe(tab.title), "Changed", csvSafe(row.key ?? ""), String((row.newIndex ?? 0) + 1),
            csvSafe(c.header), csvSafe(c.from), csvSafe(c.to), csvSafe(note), when,
          ]);
        }
      } else if (row.status === "added") {
        rows.push([
          csvSafe(tab.title), "Added", csvSafe(row.key ?? ""), String((row.newIndex ?? 0) + 1),
          "(new row)", "", csvSafe(row.values.filter(Boolean).join(" | ")), csvSafe(note), when,
        ]);
      } else {
        rows.push([
          csvSafe(tab.title), "Removed", csvSafe(row.key ?? ""), String((row.oldIndex ?? 0) + 1),
          "(deleted row)", csvSafe(row.values.filter(Boolean).join(" | ")), "", csvSafe(note), when,
        ]);
      }
    }
  }

  // provenance stamps: every export names the snapshot it came from
  const stamp = [
    `# SheetDiff changes-to-enter — generated ${new Date().toISOString()}`,
    `# Sheet: ${csvSafe(sheet.title.replace(/[\r\n]+/g, " "))}`,
  ];
  const csv = stamp.join(String.fromCharCode(10)) + String.fromCharCode(10) + Papa.unparse(rows);
  const safeTitle = sheet.title.replace(/[^\w.-]+/g, "-").slice(0, 40) || "sheet";
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sheetdiff-${safeTitle}-to-enter-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
