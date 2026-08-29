import { cookies } from "next/headers";
import { signValue, verifySigned } from "./crypto";
import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";

export const SESSION_COOKIE = "sd_session";
export const SESSION_TTL_MS = 30 * 24 * 3_600_000; // 30 days; Google refresh token does the real work

/** Signed session cookie payload for a user id. */
export const signSession = (userId: string): string => signValue(userId, SESSION_TTL_MS);

export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  return verifySigned(jar.get(SESSION_COOKIE)?.value);
}

export async function getSessionUser() {
  const id = await getSessionUserId();
  if (!id) return null;
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}
