import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { signValue } from "@/lib/crypto";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Sign in as the seeded demo user (see `npm run seed-demo`) so the diff UI can
 * be explored before Google credentials are configured. OPT-IN: only works
 * when ENABLE_DEMO=1 is set in .env — never in a real deployment.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (process.env.ENABLE_DEMO !== "1") {
    return NextResponse.redirect(new URL("/?error=demo-disabled", url.origin));
  }
  const rows = await db.select().from(users).where(eq(users.googleSub, "smoke-fake-sub")).limit(1);
  const demo = rows[0];
  if (!demo) return NextResponse.redirect(new URL("/?error=oauth-failed", url.origin));

  const res = NextResponse.redirect(new URL("/", url.origin));
  res.cookies.set(SESSION_COOKIE, signValue(demo.id), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
