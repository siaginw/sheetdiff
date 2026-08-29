import { NextResponse } from "next/server";
import Papa from "papaparse";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { spreadsheets, tabs, snapshots, changeAcks, notes as notesTable } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { decodeSnapshot } from "@/lib/snapshots";
import { diffSnapshots } from "@/lib/diff/engine";
import { isResolved } from "@/lib/sync";
import { absoluteTime } from "@/lib/format";

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
  const sheetRows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, id));
  const sheet = sheetRows[0];
  if (!sheet || sheet.userId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const tracked = (await db.select().from(tabs).where(eq(tabs.spreadsheetId, id))).filter((t) => t.tracked);
  if (tracked.length === 0) {
    return NextResponse.json({ error: "no tracked tabs" }, { status: 400 });
  }

  const all = await db
    .select()
    .from(snapshots)
    .where(inArray(snapshots.tabId, tracked.map((t) => t.id)))
    .orderBy(desc(snapshots.createdAt));

  const sheetNotes = await db.select().from(notesTable).where(eq(notesTable.spreadsheetId, id));
  const noteByRow = new Map(
    sheetNotes.filter((n) => n.rowKey).map((n) => [n.rowKey!, n.body]),
  );

  const rows: string[][] = [
    ["Tab", "Change", "Key", "Row", "Column", "Old", "New", "Note", "Snapshot"],
  ];

  for (const tab of tracked) {
    const tabSnaps = all.filter((s) => s.tabId === tab.id && s.trigger !== "import");
    if (tabSnaps.length < 2) continue;
    const latest = tabSnaps[0];
    const baseline = tabSnaps.find((s) => s.isBaseline && s.createdAt <= latest.createdAt);
    if (!baseline) continue;

    const diff = diffSnapshots(decodeSnapshot(baseline.dataBlob), decodeSnapshot(latest.dataBlob), {
      keyColumn: tab.keyColumn ?? null,
      fromWhen: baseline.createdAt,
      toWhen: latest.createdAt,
    });
    const ackRows = await db.select().from(changeAcks).where(eq(changeAcks.tabId, tab.id));
    const ackMap = new Map(ackRows.map((a) => [a.rowKey, a.ackedAt]));

    for (const row of diff.rows) {
      if (row.status === "unchanged" || row.status === "moved") continue;
      if (isResolved(ackMap, row.rowKey, latest.createdAt)) continue;
      const note = noteByRow.get(row.rowKey) ?? "";
      const when = absoluteTime(latest.createdAt);

      if (row.status === "changed") {
        for (const c of row.cells) {
          rows.push([
            tab.title, "changed", row.key ?? "", String((row.newIndex ?? 0) + 1),
            c.header, c.from, c.to, note, when,
          ]);
        }
      } else if (row.status === "added") {
        rows.push([
          tab.title, "added", row.key ?? "", String((row.newIndex ?? 0) + 1),
          "(new row)", "", row.values.filter(Boolean).join(" | "), note, when,
        ]);
      } else {
        rows.push([
          tab.title, "removed", row.key ?? "", String((row.oldIndex ?? 0) + 1),
          "(deleted row)", row.values.filter(Boolean).join(" | "), "", note, when,
        ]);
      }
    }
  }

  const csv = Papa.unparse(rows);
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
