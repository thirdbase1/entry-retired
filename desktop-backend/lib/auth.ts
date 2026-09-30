/**
 * Entry Desktop backend — standalone Next.js app.
 * Shares NOTHING with the entry-agents codebase except its Postgres DB
 * (read-only session lookup) and the same env-injected secrets.
 *
 * AUTH MODEL (verified against better-auth 1.6.29 + upstream schema):
 * - Web app signs users in (GitHub/Vercel OAuth) → rows in `users` +
 *   `auth_sessions` (columns: id, token UNIQUE, user_id, expires_at).
 * - The web app's pairing page (added there, tiny) lets a logged-in user
 *   mint a desktop pairing code stored in Redis/Upstash.
 * - This backend exchanges code→token? No: the session token itself is the
 *   secret. Pairing code maps directly to the auth_sessions.token the user
 *   is currently authenticated with — one-time read, then deleted.
 * - Desktop sends `Authorization: Bearer <session token>`; we look it up in
 *   auth_sessions with expires_at > now and join users for plan/balance.
 *
 * This backend never sees OAuth client secrets and never mints sessions —
 * only the web app does.
 */

import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";

const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://desktop.entry-agents.dev",
  "https://entry-agents.dev",
]);
// Lazy client — postgres() throws at import time with an empty URL, and Next
// collects page data before env is loaded in some build phases.
let _sql: ReturnType<typeof postgres> | null = null;
export function getSql() {
  if (!_sql) {
    _sql = postgres(process.env.DATABASE_URL ?? "", { max: 5, idle_timeout: 20 });
  }
  return _sql;
}

export function cors(req: NextRequest) {
  const origin = req.headers.get("origin") ?? "";
  const isDesktop =
    ALLOWED_ORIGINS.has(origin) && req.headers.get("x-entry-desktop") === "tauri";
  return { isDesktop, origin };
}

export function withCors(
  req: NextRequest,
  body: unknown,
  status = 200,
) {
  const { isDesktop, origin } = cors(req);
  if (!isDesktop) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, x-entry-desktop",
      Vary: "Origin",
    },
  });
}

/** Resolve the Bearer session token → user row (joined). Null if invalid. */
export async function requireSession(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length < 20) return null;
  const rows = await getSql()`
    SELECT u.id, u.username, u.email, u.avatar_url, u.is_admin,
           u.credit_balance_cents, u.plan_grant_balance_cents,
           u.billing_customer_code,
           s.expires_at, s.id AS session_id
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now()
    LIMIT 1`;
  return rows[0] ?? null;
}
