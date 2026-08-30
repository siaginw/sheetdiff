import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { googleConfigured } from "@/lib/google";
import { smtpConfigured } from "@/lib/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + config-state probe for Docker HEALTHCHECK and uptime monitors. */
export async function GET() {
  try {
    await db.run(sql`SELECT 1`);
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    db: true,
    google: googleConfigured(),
    smtp: smtpConfigured(),
    demo: process.env.ENABLE_DEMO === "1",
  });
}
