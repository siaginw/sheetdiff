import { decryptJson, encryptJson } from "@/lib/crypto";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { exchangeCode, type StoredTokens } from "@/lib/google";
import { logger } from "@/lib/logger";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "@/lib/session";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  const fail = (reason: string) => NextResponse.redirect(new URL(`/?error=${reason}`, url.origin));

  if (errParam) return fail(errParam);
  if (!code || !state) return fail("oauth-missing-code");

  const cookieState = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("sd_oauth_state="))
    ?.slice("sd_oauth_state=".length);
  if (!cookieState || cookieState !== state) return fail("oauth-state-mismatch");

  try {
    const { tokens, profile } = await exchangeCode(code);
    const existing = await db.select().from(users).where(eq(users.googleSub, profile.sub)).limit(1);

    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      // Google only returns a refresh token on first consent — keep the old one
      const prev = decryptJson<StoredTokens>(existing[0].tokensEnc);
      await db
        .update(users)
        .set({
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture,
          tokensEnc: encryptJson({
            refresh_token: tokens.refresh_token ?? prev.refresh_token ?? null,
            access_token: tokens.access_token ?? null,
            expiry_date: tokens.expiry_date ?? null,
          }),
        })
        .where(eq(users.id, userId));
    } else {
      userId = crypto.randomUUID();
      if (!tokens.refresh_token) {
        return fail("no-refresh-token");
      }
      await db.insert(users).values({
        id: userId,
        googleSub: profile.sub,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
        tokensEnc: encryptJson(tokens),
        createdAt: Date.now(),
      });
    }

    const res = NextResponse.redirect(new URL("/", url.origin));
    res.cookies.set(SESSION_COOKIE, signSession(userId), {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS / 1000,
    });
    res.cookies.delete("sd_oauth_state");
    return res;
  } catch (err) {
    // never log the raw error object — gaxios errors embed the token-exchange
    // body (auth code + client secret) in enumerable properties
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "OAuth callback failed");
    if (err instanceof Error && err.message.includes("APP_SECRET")) {
      return fail("app-secret-missing");
    }
    return fail("oauth-failed");
  }
}
