import { NextRequest, NextResponse } from "next/server";
import {
  providerConfig,
  exchangeCode,
  fetchProfile,
  type ProviderId,
} from "@/lib/oauth";
import { getSql, ensureTables } from "@/lib/db-helpers";
import { randomBytes } from "crypto";

export const runtime = "nodejs";

/**
 * GET /api/desktop/auth/callback?code=...&state=...
 * OAuth callback for the DESKTOP's own flow. Completes in one shot:
 *  1. Exchange code → provider token → profile.
 *  2. Upsert user + account rows in the SHARED tables (same users the web
 *     app reads, so plan/credits/billing carry over instantly).
 *  3. Create a session in auth_sessions (Better Auth-compatible: 32-char
 *     token, 30-day expiry) and link it to the user.
 *  4. If the state carries a device_code: mark it approved with this token.
 *  5. Show the success page; the desktop app (already polling) picks the
 *     token up automatically. Zero typing, zero code copying.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const base = process.env.BETTER_AUTH_URL ?? req.nextUrl.origin;

  const fail = (msg: string, status = 400) =>
    NextResponse.redirect(`${base}/desktop/device?error=${encodeURIComponent(msg)}`);

  if (!code || !state) return fail("Missing code or state");

  await ensureTables();
  const sql = getSql();

  // 1. Validate + consume state
  const st = await sql`
    DELETE FROM desktop_oauth_states
    WHERE state = ${state} AND expires_at > now()
    RETURNING provider, device_code, code_verifier`;
  const stateRow = st[0];
  if (!stateRow) return fail("Sign-in expired — restart from the app");
  const provider = stateRow.provider as ProviderId;

  try {
    // 2. Exchange + profile
    const cfg = providerConfig(provider, `${base}/api/desktop/auth/callback`);
    const tokens = await exchangeCode(
      cfg,
      code,
      `${base}/api/desktop/auth/callback`,
      stateRow.code_verifier ?? undefined,
    );
    if (!tokens.accessToken) return fail("Provider rejected the sign-in");
    const profile = await fetchProfile(provider, cfg, tokens.accessToken);
    if (!profile.email) {
      // Email can be private on GitHub even with the email scope granted.
      // Upstream (entry-agents) links accounts by provider account id with
      // allowDifferentEmails, so fall back to a stable synthetic address
      // instead of failing the sign-in.
      profile.email = `${provider}-${profile.providerAccountId}@users.entry.desktop`;
    }

    // 3. Upsert user (shared users table: username unique per provider prefix)
    const username = `${profile.username || profile.email.split("@")[0]}`;
    let userId: string;
    const existing = await sql`
      SELECT u.id FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.provider_id = ${provider} AND a.account_id = ${profile.providerAccountId}
      LIMIT 1`;
    if (existing[0]) {
      userId = existing[0].id;
      await sql`
        UPDATE users SET name = ${profile.name}, avatar_url = ${profile.avatar},
          email = ${profile.email}, updated_at = now(), last_login_at = now()
        WHERE id = ${userId}`;
    } else {
      const byEmail = await sql`SELECT id FROM users WHERE email = ${profile.email} LIMIT 1`;
      if (byEmail[0]) {
        userId = byEmail[0].id;
        await sql`UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = ${userId}`;
      } else {
        const id = randomBytes(16).toString("hex");
        await sql`
          INSERT INTO users (id, username, email, email_verified, name, avatar_url, is_admin,
                             credit_balance_cents, plan_grant_balance_cents, created_at, updated_at, last_login_at)
          VALUES (${id}, ${username}, ${profile.email}, true, ${profile.name}, ${profile.avatar},
                  false, 0, 0, now(), now(), now())`;
        userId = id;
      }
    }

    // 4. Upsert account row (linked identity)
    const acctId = randomBytes(16).toString("hex");
    await sql`
      INSERT INTO accounts (id, account_id, provider_id, user_id, access_token, refresh_token,
                            scope, access_token_expires_at, created_at, updated_at)
      VALUES (${acctId}, ${profile.providerAccountId}, ${provider}, ${userId},
              ${tokens.accessToken}, ${tokens.refreshToken ?? null}, ${tokens.scope ?? null},
              ${tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null},
              now(), now())
      ON CONFLICT DO NOTHING`;

    // 5. Session row (Better Auth shape: nanoid-like token, 30 days)
    const sessionId = randomBytes(16).toString("hex");
    const token = randomBytes(24).toString("base64url");
    await sql`
      INSERT INTO auth_sessions (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
      VALUES (${sessionId}, now() + interval '30 days', ${token}, now(), now(),
              ${req.headers.get("x-forwarded-for") ?? null},
              ${"entry-desktop/" + (req.headers.get("user-agent") ?? "")}, ${userId})`;

    // 6. Approve the device code (if present)
    if (stateRow.device_code) {
      await sql`
        UPDATE desktop_device_codes
        SET status = 'approved', session_token = ${token}, user_id = ${userId}, approved_at = now()
        WHERE device_code = ${stateRow.device_code} AND status = 'pending'`;
      return NextResponse.redirect(`${base}/desktop/device?approved=1&user=${encodeURIComponent(username)}`);
    }

    // Browser-only login (no device flow): show token once on our page.
    return NextResponse.redirect(`${base}/desktop/device?token=${token}`);
  } catch (e) {
    console.error("desktop oauth callback failed", e);
    return fail("Sign-in failed — try again");
  }
}
