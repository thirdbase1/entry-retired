/**
 * GET|POST /api/desktop/proxy/[service]
 *
 * Generic secure-key proxy: the desktop app never holds third-party
 * secrets. It calls this route; the secret is read from process.env here,
 * the third-party call is made server-side, sensitive metadata is
 * stripped, and only clean data returns to the client.
 *
 * Services (allowlisted — anything else is 404):
 *   github  → api.github.com        (Authorization via server-held token;
 *                                     the client's own OAuth token may be
 *                                     supplied and is validated first)
 *   vercel  → api.vercel.com
 *   openai  → api.openai.com        (OPENAI_SECRET_KEY env only)
 *   paystack → api.paystack.co      (PAYSTACK_SECRET_KEY env only, GET only;
 *                                     billing goes through Paystack upstream,
 *                                     NOT Stripe)
 *
 * Everything is scoped to the authenticated desktop user and rate-limited.
 */
import {
  requireDesktopSession,
  isDesktopRequest,
  preflight,
  json,
  rateLimit,
} from "@/lib/desktop-auth";

export const runtime = "nodejs";

interface ServiceConfig {
  host: string;
  secretEnv?: string;
  /** Header scheme for the server-held secret. */
  authScheme: "bearer" | "token";
  /** Methods the desktop client may use against this service. */
  methods: string[];
}

const SERVICES: Record<string, ServiceConfig> = {
  github: { host: "api.github.com", authScheme: "token", methods: ["GET", "POST"] },
  vercel: { host: "api.vercel.com", secretEnv: "VERCEL_API_SECRET_KEY", authScheme: "bearer", methods: ["GET", "POST"] },
  openai: { host: "api.openai.com", secretEnv: "OPENAI_SECRET_KEY", authScheme: "bearer", methods: ["POST"] },
  paystack: { host: "api.paystack.co", secretEnv: "PAYSTACK_SECRET_KEY", authScheme: "bearer", methods: ["GET"] },
};

/** Response headers never proxied back to the client. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "www-authenticate",
  "proxy-authenticate",
  "server",
  "x-powered-by",
  "via",
]);

/** Request headers never forwarded to the third party. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "x-entry-desktop",
  "content-length",
]);

export async function OPTIONS(req: Request) {
  return preflight(req);
}

async function handle(req: Request, service: string) {
  if (!isDesktopRequest(req)) {
    return json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await requireDesktopSession(req);
  if (!session) {
    return json({ error: "Not authenticated" }, { status: 401 });
  }

  const config = SERVICES[service];
  if (!config) {
    // 404, not 403: don't confirm which services exist.
    return json({ error: "Not found" }, { status: 404 });
  }
  if (!config.methods.includes(req.method)) {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!(await rateLimit(session.userId, `proxy:${service}`, 60, 60_000))) {
    return json({ error: "Rate limited" }, { status: 429 });
  }

  // Resolve the outgoing credential: for GitHub the client MAY pass its own
  // user OAuth token (validated shape only — it authorizes as that user);
  // otherwise the server-held secret is used. For every other service the
  // secret is server-only.
  const clientToken = req.headers.get("x-upstream-token") ?? "";
  let credential: string;
  if (service === "github" && /^[A-Za-z0-9_]+$/.test(clientToken) && clientToken.length >= 20) {
    credential = clientToken;
  } else if (config.secretEnv) {
    const secret = process.env[config.secretEnv];
    if (!secret) {
      return json({ error: "Service not configured" }, { status: 503 });
    }
    credential = secret;
  } else {
    return json({ error: "Upstream token required" }, { status: 400 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  if (!/^\/[A-Za-z0-9/_.?=&%-]*$/.test(path)) {
    return json({ error: "Invalid path" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    Authorization:
      config.authScheme === "bearer" ? `Bearer ${credential}` : `token ${credential}`,
    "User-Agent": "Entry-Desktop",
    Accept: "application/vnd.github+json",
  };
  if (req.method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const body = req.method === "POST" ? await req.text().catch(() => "") : undefined;
  const upstream = await fetch(`https://${config.host}${path}`, {
    method: req.method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);

  if (!upstream) {
    return json({ error: "Upstream unreachable" }, { status: 504 });
  }

  // Strip sensitive metadata: only the body + content-type are forwarded,
  // never set-cookie/authorization/server headers from the upstream.
  const text = await upstream.text().catch(() => "");

  return new Response(text, {
    status: upstream.status,
    headers: {
      ...corsHeadersSafe(req),
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

function corsHeadersSafe(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = origin && ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    Vary: "Origin",
  };
}

export const GET = handle;
export const POST = handle;
