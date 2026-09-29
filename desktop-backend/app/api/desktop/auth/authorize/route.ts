import { NextRequest, NextResponse } from "next/server";
import { providerConfig, buildAuthorizeUrl, type ProviderId } from "@/lib/oauth";
import { getSql, ensureTables } from "@/lib/db-helpers";
import { randomBytes, createHash } from "crypto";

export const runtime = "nodejs";

/**
 * GET /api/desktop/auth/authorize?provider=github|vercel&device_code=...
 * The desktop verify page redirects here. We validate the pending device
 * code, then bounce to the provider's consent screen. Callback returns to
 * /api/desktop/auth/callback which completes both the login AND the device
 * approval in one pass — the user never sees a code, never types anything
 * beyond the provider's own sign-in.
 */
export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") as ProviderId | null;
  // The verify page passes the short USER code; resolve it to the device code.
  const userCode = req.nextUrl.searchParams.get("user_code") ?? "";
  let deviceCode = req.nextUrl.searchParams.get("device_code") ?? "";
  if (!deviceCode && userCode) {
    const sql0 = getSql();
    const found = await sql0`
      SELECT device_code FROM desktop_device_codes
      WHERE code = ${userCode} AND status = 'pending' AND expires_at > now() LIMIT 1`;
    deviceCode = found[0]?.device_code ?? "";
  }
  if (!provider || !["github", "vercel"].includes(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  // Device code must be pending and unexpired (when provided).
  const sql = getSql();
  if (deviceCode) {
    const rows = await sql`
      SELECT status, expires_at FROM desktop_device_codes
      WHERE device_code = ${deviceCode} LIMIT 1`;
    if (!rows[0] || rows[0].status !== "pending" || rows[0].expires_at < new Date()) {
      return NextResponse.json({ error: "Device code invalid or expired" }, { status: 400 });
    }
  }

  const base = process.env.BETTER_AUTH_URL ?? req.nextUrl.origin;
  const redirectUri = `${base}/api/desktop/auth/callback`;
  const cfg = providerConfig(provider, redirectUri);
  const state = randomBytes(16).toString("hex");

  // Persist state → provider + device_code so the callback can trust it.
  await sql`
    INSERT INTO desktop_oauth_states (state, provider, device_code, expires_at)
    VALUES (${state}, ${provider}, ${deviceCode}, now() + interval '10 minutes')
    ON CONFLICT (state) DO NOTHING`;

  return NextResponse.redirect(buildAuthorizeUrl(cfg, redirectUri, state));
}
