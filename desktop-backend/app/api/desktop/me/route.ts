import { NextRequest, NextResponse } from "next/server";
import { requireSession, withCors } from "@/lib/auth";

export const runtime = "nodejs";

/** GET /api/desktop/me — plan + credit balance for the signed-in desktop user. */
export async function GET(req: NextRequest) {
  const { cors } = await import("@/lib/auth");
  if (!cors(req).isDesktop) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const user = await requireSession(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  return withCors(req, {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar_url,
    },
    billing: {
      plan: user.billing_customer_code ? "pro" : "free",
      creditBalanceCents: user.credit_balance_cents,
      planGrantBalanceCents: user.plan_grant_balance_cents,
      isAdmin: user.is_admin,
    },
    sessionExpiresAt: user.expires_at,
  });
}
