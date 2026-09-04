import { getSheetAccess } from "@/lib/access";
import { assembleSheetBilling } from "@/lib/billing-packet-source";
import { BillingPacketPdf } from "@/lib/billing-pdf";
import { getSessionUser } from "@/lib/session";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * The billing-day packet as a printable, fileable PDF — the artifact the
 * office attaches to the invoice batch. Built from the SAME assembly as the
 * CSV (one source of truth), on the same DATA clock.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getSheetAccess(id, user);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });

  const assembled = await assembleSheetBilling(id);
  if ("error" in assembled) return NextResponse.json({ error: "no tracked tabs" }, { status: 400 });

  const buffer = await renderToBuffer(
    <BillingPacketPdf
      packet={assembled.packet}
      sheetTitle={access.sheet.title}
      sinceFtKnown={assembled.sinceFtKnown}
    />,
  );

  const safeTitle = access.sheet.title.replace(/[^\w.-]+/g, "-").slice(0, 40) || "sheet";
  const date = new Date(assembled.dataAsOf).toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="sheetdiff-${safeTitle}-billing-${date}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
