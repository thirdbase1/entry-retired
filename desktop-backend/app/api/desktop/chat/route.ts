import { NextRequest, NextResponse } from "next/server";
import { requireSession, withCors } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

const GATEWAY_BASE = process.env.GATEWAY_BASE_URL;
const GATEWAY_KEY = process.env.GATEWAY_API_KEY;

interface ChatBody {
  modelId: string;
  reasoningEffort?: string | null;
  messages: { role: string; content: unknown }[];
  tools?: unknown[];
}

/** POST /api/desktop/chat — proxied gateway call with the server-side key. */
export async function POST(req: NextRequest) {
  const { cors } = await import("@/lib/auth");
  if (!cors(req).isDesktop) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const user = await requireSession(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.modelId || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "modelId and messages required" }, { status: 400 });
  }

  if (!GATEWAY_BASE || !GATEWAY_KEY) {
    return NextResponse.json({ error: "Model gateway unavailable" }, { status: 503 });
  }

  const upstream = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GATEWAY_KEY}`,
      "http-referer": "https://entry-agents.dev",
      "x-title": "Entry Desktop",
    },
    body: JSON.stringify({
      model: body.modelId,
      messages: body.messages,
      tools: body.tools?.length ? body.tools : undefined,
      tool_choice: body.tools?.length ? "auto" : undefined,
    }),
    signal: AbortSignal.timeout(110_000),
  }).catch(() => null);

  if (!upstream) {
    return NextResponse.json({ error: "Model gateway unreachable" }, { status: 504 });
  }
  if (!upstream.ok) {
    const status = upstream.status;
    return NextResponse.json(
      {
        error:
          status === 401 || status === 403
            ? "Model gateway rejected the request"
            : `Model error (${status})`,
      },
      { status: status >= 500 ? 502 : 400 },
    );
  }

  const completion = await upstream.json();
  return withCors(req, completion);
}
