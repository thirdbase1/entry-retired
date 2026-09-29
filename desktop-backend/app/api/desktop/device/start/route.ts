import { NextRequest, NextResponse } from "next/server";
import { getSql, ensureTables } from "@/lib/db-helpers";
import { randomBytes, createHash } from "crypto";

export const runtime = "nodejs";

/**
 * POST /api/desktop/device/start
 * Classic device-flow handshake, adapted for the Entry desktop:
 * 1. Desktop asks for a device code.
 * 2. Desktop opens the system browser at /desktop/device?code=XXXX-XXXX.
 * 3. The user signs in with GitHub/Vercel (our own Better Auth, same OAuth
 *    apps) and clicks "Approve".
 * 4. The approval stores the session token against the device code.
 * 5. Desktop polls /api/desktop/device/poll until complete → gets the token
 *    → keychain. Never typed, never copied.
 */

export async function POST(req: NextRequest) {
  await ensureTables();
  const userCode = randomBytes(4).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
  const deviceCode = createHash("sha256").update(randomBytes(32)).digest("hex");

  const sql = getSql();
  await sql`
    INSERT INTO desktop_device_codes (code, device_code, status, expires_at)
    VALUES (${userCode}, ${deviceCode}, 'pending', now() + interval '15 minutes')`;

  return NextResponse.json({
    deviceCode,
    userCode,
    verifyUrl: `${process.env.BETTER_AUTH_URL ?? "https://entry-desktop-backend.vercel.app"}/desktop/device?code=${userCode}`,
    interval: 3,
    expiresIn: 900,
  });
}
