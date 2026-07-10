/**
 * POST /api/revalidate?secret=… — on-demand ISR refresh, called by the
 * hourly GitHub Actions probe workflow after writing new snapshots.
 */

import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

export async function POST(req: Request): Promise<Response> {
  const secret = new URL(req.url).searchParams.get("secret");
  const expected = process.env.REVALIDATE_SECRET;

  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: "invalid secret" }, { status: 401 });
  }

  revalidatePath("/");
  return NextResponse.json({ ok: true, revalidated: ["/"], at: new Date().toISOString() });
}
