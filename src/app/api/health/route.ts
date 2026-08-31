import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { spreadsheets } from "@/lib/db/schema";
import { googleConfigured } from "@/lib/google";
import { smtpConfigured } from "@/lib/digest";
import { captureIsStale } from "@/lib/staleness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + config-state probe for Docker HEALTHCHECK and uptime monitors.
 *  `staleCaptures` counts scheduled sheets whose latest snapshot exceeds the
 *  shared staleness window — a scheduler/token failure the app cannot see any
 *  other way (pages still render fine from old data). It does NOT fail the
 *  probe: the service is up; the operator should read the number. */
export async function GET() {
  try {
    await db.run(sql`SELECT 1`);
    // a real table probe: "SELECT 1" alone goes green with zero tables created
    await db.run(sql`SELECT 1 FROM users LIMIT 1`);
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
  let staleCaptures = 0;
  try {
    const sheets = await db.select().from(spreadsheets);
    staleCaptures = sheets.filter((s) => captureIsStale(s)).length;
  } catch {
    // non-fatal: the probe's job is liveness
  }
  return NextResponse.json({
    ok: true,
    db: true,
    google: googleConfigured(),
    smtp: smtpConfigured(),
    demo: process.env.ENABLE_DEMO === "1",
    staleCaptures,
  });
}
