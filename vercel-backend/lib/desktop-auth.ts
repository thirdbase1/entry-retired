/**
 * Desktop-to-cloud shared utilities.
 *
 * Security pattern (from the project contract):
 * 1. Zero client secrets — the desktop app sends only a Bearer token.
 * 2. Secure key proxying — third-party secret keys live ONLY in Vercel env
 *    vars; the desktop app talks to OUR endpoint, we call the third party.
 * 3. CORS — desktop clients run on tauri://localhost (Linux/Windows) and
 *    tauri://localhost or http://tauri.localhost (WebView2). Ordinary web
 *    browsers are rejected by origin allowlist + a custom header requirement.
 * 4. Auth — every route verifies the session token via Better Auth
 *    (`auth.api.getSession` accepts the Authorization header for bearer
 *    tokens, exactly what a desktop client sends).
 * 5. Rate limiting — fixed-window counter per user+route, backed by
 *    Upstash Redis when UPSTASH_REDIS_REST_URL is set; in-process fallback
 *    for dev (per-server-instance, degraded but functional).
 */
import { auth } from "@/lib/auth/config";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface DesktopSession {
  userId: string;
  email: string;
}

/**
 * Verify the desktop client's Bearer token. Returns null on any failure —
 * routes must respond 401 without leaking why.
 */
export async function requireDesktopSession(
  req: Request,
): Promise<DesktopSession | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token.length < 20) return null;

  try {
    // Better Auth resolves bearer tokens through the same session store as
    // cookies (bearer plugin enabled in auth config).
    const session = await auth.api.getSession({
      headers: new Headers({
        authorization: `Bearer ${token}`,
        cookie: req.headers.get("cookie") ?? "",
      }),
    });
    if (!session?.user?.id) return null;
    return {
      userId: session.user.id,
      email: session.user.email ?? "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Desktop origins only. Web browsers hitting these routes are rejected. */
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost", // Windows WebView2 custom protocol mapping
  "https://tauri.localhost",
]);

/** Required custom header a browser would never send unprompted. */
export const DESKTOP_CLIENT_HEADER = "x-entry-desktop";

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin !== null && ALLOWED_ORIGINS.has(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Authorization, Content-Type, ${DESKTOP_CLIENT_HEADER}`,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Full CORS prefilter: rejects browser-originated requests before any auth
 * or DB work. A legitimate desktop request must (a) come from a tauri://
 * origin, and (b) carry the custom client header.
 */
export function isDesktopRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  const isTauriOrigin = origin === null || ALLOWED_ORIGINS.has(origin);
  // No origin at all is allowed: fetch() from a custom-protocol context may
  // omit it; the required client header is what distinguishes us from curl.
  return isTauriOrigin && req.headers.has(DESKTOP_CLIENT_HEADER);
}

export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "private, no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, per user + route bucket)
// ---------------------------------------------------------------------------

interface WindowState {
  windowStart: number;
  count: number;
}

const localWindows = new Map<string, WindowState>();

export async function rateLimit(
  userId: string,
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const key = `${bucket}:${userId}`;
  const now = Date.now();

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    // Distributed fixed window via Upstash REST.
    const redisKey = `rl:${key}:${Math.floor(now / windowMs)}`;
    const res = await fetch(`${redisUrl}/incr/${encodeURIComponent(redisKey)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${redisToken}` },
    }).catch(() => null);
    if (res?.ok) {
      const { value } = (await res.json()) as { value: number };
      if (value === 1) {
        await fetch(`${redisUrl}/pexpire/${encodeURIComponent(redisKey)}/${windowMs}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${redisToken}` },
        }).catch(() => null);
      }
      return value <= limit;
    }
    // Redis unreachable → fall through to local limiter (fail-closed on
    // distributed, fail-open locally is the lesser risk for reads).
  }

  const state = localWindows.get(key);
  if (!state || now - state.windowStart >= windowMs) {
    localWindows.set(key, { windowStart: now, count: 1 });
    return true;
  }
  state.count += 1;
  return state.count <= limit;
}
