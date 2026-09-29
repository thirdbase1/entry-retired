/**
 * POST /api/desktop/chat
 *
 * Secure model proxy: the desktop app NEVER receives or sends a gateway
 * API key. It posts the conversation + model selection here; this route
 * reads GATEWAY_API_KEY from process.env, applies the caller's plan/credit
 * gates, calls entry-gateway, debits the caller's credit ledger, and
 * returns only the clean model response.
 *
 * This is the desktop equivalent of the web app's runAgentStep billing
 * path: gate → call model → accrue usage debit → return.
 */
import {
  requireDesktopSession,
  isDesktopRequest,
  preflight,
  json,
  rateLimit,
} from "@/lib/desktop-auth";
import { getUserBillingState, debitUsage } from "@/lib/billing/credit-ledger";
import { estimateModelUsageCost } from "@/lib/models";
import { getPlanDefinition, FREE_PLAN_MODEL_ID, FREE_TIER_ALLOWED_MODEL_IDS } from "@/lib/billing/plans";
import { isUserAdmin } from "@/lib/db/users";

export const runtime = "nodejs";
export const maxDuration = 120;

interface DesktopChatRequest {
  modelId: string;
  reasoningEffort?: string | null;
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string }[];
  tools?: unknown[];
}

export async function OPTIONS(req: Request) {
  return preflight(req);
}

function badRequest(msg: string) {
  return json({ error: msg }, { status: 400 });
}

export async function POST(req: Request) {
  if (!isDesktopRequest(req)) {
    return json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await requireDesktopSession(req);
  if (!session) {
    return json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: DesktopChatRequest;
  try {
    body = (await req.json()) as DesktopChatRequest;
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (!body.modelId || typeof body.modelId !== "string") {
    return badRequest("modelId is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequest("messages must be a non-empty array");
  }

  // ---- Plan + credit gates (mirror upstream resolveChatModelRuntime) ----
  const [billingState, isAdmin] = await Promise.all([
    getUserBillingState(session.userId),
    isUserAdmin(session.userId).catch(() => false),
  ]);
  const plan = getPlanDefinition(billingState?.plan);
  const balanceCents = billingState?.creditBalanceCents ?? 0;

  if (!isAdmin) {
    if (balanceCents <= 0) {
      return json(
        {
          error:
            plan.modelAccess === "luna-only"
              ? "Free tier ended — upgrade your account to use Entry"
              : "You're out of credit — top up to keep chatting",
          code: plan.modelAccess === "luna-only" ? "free_tier_ended" : "out_of_credit",
        },
        { status: 402 },
      );
    }
    if (plan.modelAccess === "luna-only" && !FREE_TIER_ALLOWED_MODEL_IDS.includes(body.modelId)) {
      return json(
        { error: "Your plan only allows the free model. Upgrade for the full catalog.", code: "model_not_in_plan" },
        { status: 402 },
      );
    }
  }

  // Free plan is pinned to the free model regardless of what was asked.
  const effectiveModel =
    !isAdmin && plan.modelAccess === "luna-only" ? FREE_PLAN_MODEL_ID : body.modelId;

  // Per-turn rate limit — model calls are the expensive bucket.
  if (!(await rateLimit(session.userId, "chat", 20, 60_000))) {
    return json({ error: "Rate limited" }, { status: 429 });
  }

  // ---- Proxy the call with the server-side secret ----
  const gatewayBase = process.env.GATEWAY_BASE_URL;
  const gatewayKey = process.env.GATEWAY_API_KEY;
  if (!gatewayBase || !gatewayKey) {
    // Server misconfiguration — never expose which part.
    return json({ error: "Model gateway unavailable" }, { status: 503 });
  }

  const upstreamBody: Record<string, unknown> = {
    model: effectiveModel,
    messages: body.messages,
    tool_choice: body.tools?.length ? "auto" : undefined,
    tools: body.tools?.length ? body.tools : undefined,
  };

  // Reasoning effort: sanitized per model upstream-side (same contract as
  // the desktop's model_selection.rs — invalid values are dropped).
  if (body.reasoningEffort) {
    const { sanitizeReasoningEffort, toReasoningProviderOptions } = await import(
      "@/lib/model-reasoning"
    );
    const effort = sanitizeReasoningEffort(effectiveModel, body.reasoningEffort);
    if (effort) {
      const providerOptions = toReasoningProviderOptions(effort, effectiveModel);
      // chat-completions shape: reasoning_effort / thinking / thinkingConfig
      if (providerOptions?.openai?.reasoningEffort) {
        upstreamBody.reasoning_effort = providerOptions.openai.reasoningEffort;
      } else if (providerOptions?.anthropic?.thinking) {
        upstreamBody.thinking = providerOptions.anthropic.thinking;
      }
    }
  }

  const started = Date.now();
  const upstream = await fetch(`${gatewayBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gatewayKey}`,
      "http-referer": "https://open-agents.dev",
      "x-title": "Entry Desktop",
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(110_000),
  }).catch(() => null);

  if (!upstream) {
    return json({ error: "Model gateway unreachable" }, { status: 504 });
  }
  if (!upstream.ok) {
    const status = upstream.status;
    const text = await upstream.text().catch(() => "");
    // Never relay upstream auth errors verbatim (would leak route info).
    return json(
      { error: status === 401 || status === 403 ? "Model gateway rejected the request" : `Model error (${status})` },
      { status: status >= 500 ? 502 : 400 },
    );
  }

  type Usage = { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const completion = (await upstream.json()) as {
    choices?: { message?: unknown }[];
    usage?: Usage;
  };
  const message = completion.choices?.[0]?.message;
  if (!message) {
    return json({ error: "Model returned no choices" }, { status: 502 });
  }

  // ---- Usage debit (mirror usage-accrual: full precision, lazy cents) ----
  let debitCents = 0;
  if (!isAdmin && completion.usage) {
    // Upstream realtime-spend-cap path: estimateModelUsageCost from the
    // pricing catalog, then debitUsage with whole cents (lazy accrual
    // upstream handles sub-cent carry; this proxy debits per call).
    const costUsd = estimateModelUsageCost(effectiveModel, {
      promptTokens: completion.usage.prompt_tokens ?? 0,
      completionTokens: completion.usage.completion_tokens ?? 0,
    });
    if (costUsd !== undefined) {
      const costCents = Math.max(0, Math.round(costUsd * 100));
      debitCents = await debitUsage(
        session.userId,
        costCents,
        { description: "desktop_chat_proxy", modelId: effectiveModel },
      ).catch(() => 0);
    }
  }

  return json({
    message,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      debitedCents: debitCents,
      durationMs: Date.now() - started,
    },
    // The new balance lets the desktop widget update without a second call.
    creditBalanceCents: isAdmin
      ? null
      : ((await getUserBillingState(session.userId).catch(() => null))?.creditBalanceCents ?? null),
  });
}
