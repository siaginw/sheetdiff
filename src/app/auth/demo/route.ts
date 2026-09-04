import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "@/lib/session";
import { eq, notInArray } from "drizzle-orm";
import { NextResponse } from "next/server";

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
  // Same rule seed-demo applies, mirrored here: if this database ever became
  // a real deployment (real users exist), the flag being left on must not
  // expose a no-credential login to the network. Demo data only.
  const realUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(notInArray(users.googleSub, ["smoke-fake-sub", "viewer-fake-sub"]))
    .limit(1);
  if (realUsers.length > 0) {
    return NextResponse.redirect(new URL("/?error=demo-disabled", url.origin));
  }
  const asViewer = url.searchParams.get("as") === "viewer";
  const sub = asViewer ? "viewer-fake-sub" : "smoke-fake-sub";
  const rows = await db.select().from(users).where(eq(users.googleSub, sub)).limit(1);
  const demo = rows[0];
  if (!demo) return NextResponse.redirect(new URL("/?error=demo-not-seeded", url.origin));

  const res = NextResponse.redirect(new URL("/", url.origin));
  res.cookies.set(SESSION_COOKIE, signSession(demo.id), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}
