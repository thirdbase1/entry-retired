import { NextRequest, NextResponse } from "next/server";
import { getSql, cors, withCors } from "@/lib/auth";

export const runtime = "nodejs";

/** POST /api/desktop/signout — revoke the desktop session server-side. */
export async function POST(req: NextRequest) {
  if (!cors(req).isDesktop) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) {
    const sql = getSql();
    await sql`DELETE FROM auth_sessions WHERE token = ${token}`;
  }
  return withCors(req, { ok: true });
}
