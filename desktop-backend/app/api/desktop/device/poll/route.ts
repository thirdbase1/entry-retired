import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/db-helpers";

export const runtime = "nodejs";

const SLOW_DOWN = NextResponse.json(
  { status: "slow_down", interval: 6 },
  { status: 428 },
);

/** POST /api/desktop/device/poll — desktop polls until approved or expired. */
export async function POST(req: NextRequest) {
  const { deviceCode } = (await req.json()) as { deviceCode?: string };
  if (!deviceCode || deviceCode.length < 32) {
    return NextResponse.json({ error: "Invalid device code" }, { status: 400 });
  }

  const sql = getSql();
  const rows = await sql`
    SELECT dc.status, dc.session_token, dc.user_id, dc.expires_at,
           u.username, u.email, u.avatar_url
    FROM desktop_device_codes dc
    LEFT JOIN users u ON u.id = dc.user_id
    WHERE dc.device_code = ${deviceCode}
    LIMIT 1`;

  const row = rows[0];
  if (!row) {
    return NextResponse.json({ status: "expired" }, { status: 404 });
  }
  if (row.expires_at < new Date()) {
    return NextResponse.json({ status: "expired" }, { status: 410 });
  }
  if (row.status === "pending") {
    return NextResponse.json({ status: "pending" });
  }
  if (row.status === "denied") {
    return NextResponse.json({ status: "denied" }, { status: 403 });
  }

  // Approved: return the session token ONCE, then destroy the mapping so the
  // token can't be re-read even if the device code leaks.
  await sql`DELETE FROM desktop_device_codes WHERE device_code = ${deviceCode}`;
  return NextResponse.json({
    status: "complete",
    sessionToken: row.session_token,
    user: { username: row.username, email: row.email, avatar: row.avatar_url },
  });
}
