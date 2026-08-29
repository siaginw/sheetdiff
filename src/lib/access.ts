import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { members, spreadsheets, type Spreadsheet, type User } from "./db/schema";

/**
 * Access control: owners see and control their own sheets; members (matched
 * by Google account email) get viewer access to the owner's sheets — read
 * everything, write audit notes, tick off changes, mark collections.
 * Every owner-only mutation still goes through requireOwnedSpreadsheet /
 * requireOwnedTab in actions.ts; this layer is what pages and shared
 * actions use.
 */

export type SheetRole = "owner" | "viewer";

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

export async function listAccessibleSpreadsheets(user: Pick<User, "id" | "email">): Promise<Spreadsheet[]> {
  const own = await db.select().from(spreadsheets).where(eq(spreadsheets.userId, user.id));
  let shared: Spreadsheet[] = [];
  if (user.email) {
    const rows = await db
      .select()
      .from(members)
      .where(eq(members.email, normEmail(user.email)));
    const ownerIds = [...new Set(rows.map((r) => r.ownerUserId))].filter((id) => id !== user.id);
    if (ownerIds.length > 0) {
      shared = await db.select().from(spreadsheets).where(inArray(spreadsheets.userId, ownerIds));
    }
  }
  return [...own, ...shared];
}

export async function getSheetAccess(
  spreadsheetId: string,
  user: Pick<User, "id" | "email">,
): Promise<{ sheet: Spreadsheet; role: SheetRole } | null> {
  const rows = await db.select().from(spreadsheets).where(eq(spreadsheets.id, spreadsheetId));
  const sheet = rows[0];
  if (!sheet) return null;
  if (sheet.userId === user.id) return { sheet, role: "owner" };
  if (user.email) {
    const member = await db
      .select()
      .from(members)
      .where(eq(members.email, normEmail(user.email)));
    if (member.some((m) => m.ownerUserId === sheet.userId)) {
      return { sheet, role: "viewer" };
    }
  }
  return null;
}

export async function listMembers(ownerUserId: string) {
  return db.select().from(members).where(eq(members.ownerUserId, ownerUserId));
}
