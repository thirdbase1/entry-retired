/**
 * Desktop mirror of apps/web/lib/model-reasoning.ts's level lookup —
 * server-side copy of the per-model vocabularies so the /models route can
 * tell the desktop picker exactly which effort levels each model accepts.
 * Keep in sync with the desktop's src-tauri/src/model_selection.rs.
 */

export interface ReasoningEffortLevel {
  value: string;
  label: string;
}

const DEFAULT_LEVELS: ReasoningEffortLevel[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const MODEL_REASONING_LEVELS: Record<string, ReasoningEffortLevel[]> = {
  "qwen3.8-max-free": [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "XHigh" },
  ],
  "qwen3.8-27b": [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "XHigh" },
  ],
  "gpt-5.6-luna": [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
  ],
  "gpt-5.6-sol": [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
    { value: "max", label: "Max" },
  ],
  "gpt-5.6-terra": [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
    { value: "max", label: "Max" },
  ],
  "glm-5.3-flash": [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
  ],
  "qwen3.8-flash": [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
    { value: "max", label: "Max" },
  ],
};

const REASONING_CAPABLE_MODEL_IDS = new Set([
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
]);

export function modelReasoningLevels(modelId: string): ReasoningEffortLevel[] | null {
  if (!REASONING_CAPABLE_MODEL_IDS.has(modelId)) return null;
  return MODEL_REASONING_LEVELS[modelId] ?? DEFAULT_LEVELS;
}
