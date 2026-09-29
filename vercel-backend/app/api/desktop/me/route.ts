/**
 * GET /api/desktop/me
 *
 * Desktop mirror of upstream /api/billing/me + /api/models gate info:
 * plan, credit balance, usage windows, user identity. Everything the
 * sidebar balance widget needs, keyed off the Bearer token's user.
 */
import {
  requireDesktopSession,
  isDesktopRequest,
  preflight,
  json,
  rateLimit,
} from "@/lib/desktop-auth";
import { enforcePlanExpiry, getUsageWindowTotals } from "@/lib/billing/credit-ledger";
import { getPlanDefinition } from "@/lib/billing/plans";
import { isUserAdmin } from "@/lib/db/users";

export const runtime = "nodejs";

export async function OPTIONS(req: Request) {
  return preflight(req);
}

export async function GET(req: Request) {
  if (!isDesktopRequest(req)) {
    return json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await requireDesktopSession(req);
  if (!session) {
    return json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!(await rateLimit(session.userId, "me", 60, 60_000))) {
    return json({ error: "Rate limited" }, { status: 429 });
  }

  const isAdmin = await isUserAdmin(session.userId).catch(() => false);
  const state = await enforcePlanExpiry(session.userId, { isAdmin });
  if (!state) {
    return json({ error: "User not found" }, { status: 404 });
  }

  const plan = getPlanDefinition(state.plan);
  let usageWindows: {
    fiveHour: { usedCents: number; limitCents: number };
    weekly: { usedCents: number; limitCents: number };
    monthly: { usedCents: number; limitCents: number };
  } | null = null;
  if (plan.usageWindows) {
    const totals = await getUsageWindowTotals(session.userId);
    usageWindows = {
      fiveHour: {
        usedCents: totals.last5HoursCents,
        limitCents: plan.usageWindows.fiveHourLimitCents,
      },
      weekly: {
        usedCents: totals.last7DaysCents,
        limitCents: plan.usageWindows.weeklyLimitCents,
      },
      monthly: {
        usedCents: totals.last30DaysCents,
        limitCents: plan.usageWindows.monthlyLimitCents,
      },
    };
  }

  return json({
    user: { id: session.userId, email: session.email },
    plan: state.plan,
    planName: plan.name,
    modelAccess: plan.modelAccess,
    creditBalanceCents: state.creditBalanceCents,
    creditGrantCents: plan.creditGrantCents,
    usageWindows,
  });
}
