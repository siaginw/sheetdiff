import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { generateAuthUrl, googleConfigured } from "@/lib/google";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?error=google-not-configured", req.url));
  }
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(generateAuthUrl(state));
  res.cookies.set("sd_oauth_state", state, {
    httpOnly: true,
    path: "/",
    maxAge: 600,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
