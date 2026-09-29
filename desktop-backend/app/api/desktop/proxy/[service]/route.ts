import { NextRequest, NextResponse } from "next/server";
import { requireSession, withCors, cors } from "@/lib/auth";

export const runtime = "nodejs";

/** Secrets this backend will proxy, per service. Nothing else. */
const SERVICE_ENV: Record<string, string> = {
  github: "GITHUB_PROXY_TOKEN",
  vercel: "VERCEL_PROXY_TOKEN",
};

const BLOCKED_REQ_HEADERS = new Set(["authorization", "cookie", "host", "content-length"]);

/**
 * GET|POST /api/desktop/proxy/[service]
 * Secure-key proxy: the desktop never holds third-party secrets. The secret
 * is read from process.env here, the call is made server-side, sensitive
 * headers are stripped from the response.
 */
async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ service: string }> },
) {
  const user = await requireSession(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { service } = await ctx.params;
  const envKey = SERVICE_ENV[service];
  if (!envKey) {
    return NextResponse.json({ error: "Unknown service" }, { status: 404 });
  }
  const token = process.env[envKey];
  if (!token) {
    return NextResponse.json({ error: "Service not configured" }, { status: 503 });
  }

  const target = req.nextUrl.searchParams.get("url");
  if (!target || !/^https:\/\/(api\.(github|vercel)\.com)\//.test(target)) {
    return NextResponse.json({ error: "Invalid target URL" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Entry-Desktop",
    Accept: "application/vnd.github+json",
  };
  const init: RequestInit = { headers, signal: AbortSignal.timeout(30_000) };
  if (req.method === "POST") {
    init.method = "POST";
    headers["Content-Type"] = "application/json";
    init.body = await req.text();
  }

  const upstream = await fetch(target, init).catch(() => null);
  if (!upstream) {
    return NextResponse.json({ error: "Upstream unreachable" }, { status: 504 });
  }

  const resHeaders = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  });
  const { isDesktop, origin } = cors(req);
  if (isDesktop) {
    resHeaders.set("Access-Control-Allow-Origin", origin);
    resHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, x-entry-desktop");
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

export const GET = handle;
export const POST = handle;

export async function OPTIONS(req: NextRequest) {
  return NextResponse.json({}, { status: 204 });
}
