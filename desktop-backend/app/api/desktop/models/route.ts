import { NextRequest, NextResponse } from "next/server";
import { requireSession, withCors } from "@/lib/auth";

export const runtime = "nodejs";

const UPSTREAM_MODELS_URL = "https://entry-agents.dev/api/models";

/**
 * GET /api/desktop/models — gateway model catalog for the model picker.
 * Reads the public upstream catalog (same gateway the web app uses) and
 * attaches balance context. No secrets involved client-side.
 */
export async function GET(req: NextRequest) {
  const { cors } = await import("@/lib/auth");
  if (!cors(req).isDesktop) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const user = await requireSession(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const res = await fetch(UPSTREAM_MODELS_URL, { next: { revalidate: 300 } }).catch(
    () => null,
  );
  if (!res?.ok) {
    return NextResponse.json({ error: "Catalog unavailable" }, { status: 502 });
  }
  const { models } = (await res.json()) as { models: unknown[] };
  return withCors(req, {
    models,
    billing: {
      creditBalanceCents: user.credit_balance_cents,
      planGrantBalanceCents: user.plan_grant_balance_cents,
      isAdmin: user.is_admin,
    },
  });
}
