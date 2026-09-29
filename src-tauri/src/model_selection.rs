//! Model selection and reasoning-effort contracts, ported from entry-agents.
//!
//! Upstream sources of truth:
//! - `packages/agent/models.ts` — sharedProvider(): per-model-ID provider
//!   routing, gateway env vars, per-model default settings.
//! - `apps/web/lib/model-reasoning.ts` — per-model reasoning vocabularies
//!   verified by live probes; `sanitizeReasoningEffort`,
//!   `toReasoningProviderOptions`, `ANTHROPIC_THINKING_BUDGETS`.
//! - `apps/web/lib/models-with-context.ts` — `GET {baseURL}/models` catalog.
//!
//! Wire-shape rule (upstream doc comment): the value the UI picks is the
//! exact string sent over the wire — never translated or remapped.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Upstream `DEFAULT_LEVELS`: vocabulary most reasoning-capable upstreams
/// share (OpenAI-style low/medium/high, Gemini thinkingLevel).
pub const DEFAULT_LEVELS: &[(&str, &str)] =
    &[("low", "Low"), ("medium", "Medium"), ("high", "High")];

/// Upstream `ANTHROPIC_THINKING_BUDGETS`: Claude models routed through an
/// OpenAI-compatible gateway respond to legacy `thinking.budget_tokens`,
/// NOT adaptive/effort thinking (live-probe confirmed upstream: adaptive is
/// a silent no-op on that passthrough). Each UI level maps to a budget.
pub const ANTHROPIC_THINKING_BUDGETS: &[(&str, i64)] = &[
    ("low", 2000),
    ("medium", 8000),
    ("high", 16000),
    ("max", 32000), // Opus line + Sonnet 5 only; double the "high" budget
];

/// Upstream `MODEL_REASONING_LEVELS` — per-model overrides where the real
/// accepted vocabulary differs from the default. Values are the exact
/// strings the upstream accepts (live-probe verified by upstream; see the
/// commentary in apps/web/lib/model-reasoning.ts).
pub fn model_reasoning_levels(model_id: &str) -> &'static [(&'static str, &'static str)] {
    match model_id {
        // Rejects "high" outright: "reasoning_effort must be low, medium, or xhigh".
        "qwen3.8-max-free" => &[("low", "Low"), ("medium", "Medium"), ("xhigh", "XHigh")],
        // Documented none/low/medium/xhigh; "none" genuinely disables thinking.
        "qwen3.8-27b" => &[
            ("none", "Off"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("xhigh", "XHigh"),
        ],
        // Luna rejects "max" (400 "level \"max\" not supported") while its
        // Sol/Terra siblings accept it — verified per-model, not per-family.
        "gpt-5.6-luna" => &[
            ("none", "Off"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "XHigh"),
        ],
        "gpt-5.6-sol" | "gpt-5.6-terra" => &[
            ("none", "Off"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "XHigh"),
            ("max", "Max"),
        ],
        // GLM-5.3-Flash cannot disable thinking at all (upstream 400s on
        // none/medium; only low/high/max accepted).
        "glm-5.3-flash" => &[("low", "Low"), ("high", "High"), ("max", "Max")],
        // Full none..max vocabulary; "none" is a real disable.
        "qwen3.8-flash" => &[
            ("none", "Off"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "XHigh"),
            ("max", "Max"),
        ],
        _ => DEFAULT_LEVELS,
    }
}

/// Upstream `isClaudeModelId` / `isGeminiModelId` routing predicates.
pub fn is_claude_model_id(model_id: &str) -> bool {
    model_id.starts_with("claude-")
}

pub fn is_gemini_model_id(model_id: &str) -> bool {
    model_id.starts_with("gemini-") || model_id.starts_with("gemma-")
}

/// A model in the gateway's catalog. Mirrors the enrichment upstream's
/// `fetchGatewayModelsUncached` layers onto `GET {GATEWAY_BASE_URL}/models`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayModel {
    pub id: String,
    #[serde(default)]
    pub reasoning_capable: bool,
    /// The vocabulary this specific model accepts (empty = not reasoning-capable).
    #[serde(default)]
    pub reasoning_levels: Vec<ReasoningEffortLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortLevel {
    pub value: String,
    pub label: String,
}

/// Upstream `REASONING_CAPABLE_MODEL_IDS`: routes confirmed to actually
/// honor reasoning_effort (some upstreams silently ignore unknown fields,
/// which would make the selector a no-op).
pub const REASONING_CAPABLE_MODEL_IDS: &[&str] = &[
    "deepseek-v4-pro",
    "glm-5.2",
    "deepseek-v4-flash",
    "step-3.7-flash",
    "hy3",
    "qwen3.8-max-free",
    "qwen3.8-27b",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "glm-5.3-flash",
    "qwen3.8-flash",
];

pub fn is_reasoning_capable_model(model_id: &str) -> bool {
    REASONING_CAPABLE_MODEL_IDS.contains(&model_id)
}

/// Upstream `sanitizeReasoningEffort`: validate a requested effort against
/// the model's real vocabulary. None means "use the model's default".
pub fn sanitize_reasoning_effort(model_id: &str, value: Option<&str>) -> Option<String> {
    let value = value?;
    if !is_reasoning_capable_model(model_id) {
        return None;
    }
    model_reasoning_levels(model_id)
        .iter()
        .any(|(v, _)| *v == value)
        .then(|| value.to_string())
}

/// Upstream `toReasoningProviderOptions`: translate a sanitized effort into
/// the wire shape the model's actual route understands. Three branches:
/// Gemini → thinkingConfig.thinkingLevel; Claude → legacy budget_tokens
/// (NOT adaptive — silent no-op on the gateway passthrough); everything
/// else → openai.reasoningEffort nested under the literal "openai" key
/// (the AI SDK's OpenAI-compatible provider only reads that key).
pub fn to_reasoning_request_fields(effort: &str, model_id: &str) -> Value {
    if is_gemini_model_id(model_id) {
        serde_json::json!({
            "generationConfig": {
                "thinkingConfig": { "includeThoughts": true, "thinkingLevel": effort }
            }
        })
    } else if is_claude_model_id(model_id) {
        let budget = ANTHROPIC_THINKING_BUDGETS
            .iter()
            .find(|(v, _)| *v == effort)
            .map(|(_, b)| *b)
            .unwrap_or(8000); // upstream falls back to the medium budget
        serde_json::json!({
            "thinking": { "type": "enabled", "budget_tokens": budget }
        })
    } else {
        // OpenAI-compatible chat route: reasoning_effort at top level of
        // the request body (chat-completions shape of reasoningEffort).
        serde_json::json!({ "reasoning_effort": effort })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_model_vocabularies_match_upstream() {
        assert!(sanitize_reasoning_effort("qwen3.8-max-free", Some("xhigh")).is_some());
        assert!(sanitize_reasoning_effort("qwen3.8-max-free", Some("high")).is_none());
        assert!(sanitize_reasoning_effort("gpt-5.6-luna", Some("max")).is_none());
        assert!(sanitize_reasoning_effort("gpt-5.6-sol", Some("max")).is_some());
        assert!(sanitize_reasoning_effort("gpt-5.6-terra", Some("max")).is_some());
        assert!(sanitize_reasoning_effort("glm-5.3-flash", Some("none")).is_none());
        assert!(sanitize_reasoning_effort("glm-5.3-flash", Some("low")).is_some());
        assert!(sanitize_reasoning_effort("qwen3.8-27b", Some("none")).is_some());
    }

    #[test]
    fn non_reasoning_models_get_null_effort() {
        assert!(sanitize_reasoning_effort("kimi-k3", Some("high")).is_none());
        assert!(sanitize_reasoning_effort("unknown-model", Some("high")).is_none());
    }

    #[test]
    fn claude_effort_maps_to_budget_tokens() {
        let fields = to_reasoning_request_fields("max", "claude-opus-5");
        assert_eq!(fields["thinking"]["budget_tokens"], 32000);
        let fields = to_reasoning_request_fields("low", "claude-sonnet-5");
        assert_eq!(fields["thinking"]["budget_tokens"], 2000);
        // Unknown value falls back to medium (upstream behavior).
        let fields = to_reasoning_request_fields("bogus", "claude-opus-5");
        assert_eq!(fields["thinking"]["budget_tokens"], 8000);
    }

    #[test]
    fn openai_compat_effort_uses_reasoning_effort_key() {
        let fields = to_reasoning_request_fields("high", "deepseek-v4-pro");
        assert_eq!(fields["reasoning_effort"], "high");
        let fields = to_reasoning_request_fields("xhigh", "qwen3.8-max-free");
        assert_eq!(fields["reasoning_effort"], "xhigh");
    }

    #[test]
    fn gemini_effort_uses_thinking_level() {
        let fields = to_reasoning_request_fields("high", "gemini-3-pro");
        assert_eq!(
            fields["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );
    }
}
