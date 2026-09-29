/**
 * GET /api/desktop/models
 *
 * Desktop mirror of upstream /api/models: the gateway model catalog
 * filtered by the caller's plan + credit gates. The desktop app calls this
 * to populate its model picker; it never talks to the model gateway
 * directly with a shared key. Secrets stay server-side.
 */
import {
  requireDesktopSession,
  isDesktopRequest,
  preflight,
  json,
  rateLimit,
} from "@/lib/desktop-auth";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
import { filterModelsForSession } from "@/lib/model-access";
import { getUserBillingState } from "@/lib/billing/credit-ledger";
import { getPlanDefinition, FREE_PLAN_MODEL_ID } from "@/lib/billing/plans";
import { isUserAdmin } from "@/lib/db/users";
import { modelReasoningLevels } from "@/lib/desktop-model-reasoning";

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
  if (!(await rateLimit(session.userId, "models", 30, 60_000))) {
    return json({ error: "Rate limited" }, { status: 429 });
  }

  const [catalog, billingState, isAdmin] = await Promise.all([
    fetchAvailableLanguageModelsWithContext(),
    getUserBillingState(session.userId).catch(() => null),
    isUserAdmin(session.userId).catch(() => false),
  ]);

  const plan = getPlanDefinition(billingState?.plan);
  const balanceCents = billingState?.creditBalanceCents ?? 0;

  const creditGate =
    !isAdmin && balanceCents <= 0
      ? {
          blocked: true,
          kind: (plan.modelAccess === "luna-only" ? "free" : "paid") as
            | "free"
            | "paid",
          reason:
            plan.modelAccess === "luna-only"
              ? "Free tier ended — upgrade your account to use Entry"
              : "You're out of credit — top up to keep chatting",
        }
      : { blocked: false, kind: null, reason: null };

  // Reuse upstream's plan/credit filtering logic, then attach each model's
  // verified reasoning vocabulary so the desktop picker renders the exact
  // effort levels that model actually accepts.
  const filtered = filterModelsForSession(catalog, {
    plan: plan.id,
    isAdmin,
  });

  const models = filtered.map((m: { id: string }) => ({
    id: m.id,
    reasoningCapable: modelReasoningLevels(m.id) !== null,
    reasoningLevels: modelReasoningLevels(m.id) ?? [],
    freeTierAllowed: m.id === FREE_PLAN_MODEL_ID,
  }));

  return json({
    models,
    plan: plan.id,
    modelAccess: plan.modelAccess,
    creditGate,
    defaultModelId: plan.modelAccess === "luna-only" ? FREE_PLAN_MODEL_ID : undefined,
  });
}
