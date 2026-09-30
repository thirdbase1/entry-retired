// Agent runtime surface — typed wrappers over the session-log Tauri commands.

import { invoke } from "@tauri-apps/api/core";

export interface AgentEvent {
  task_id: string;
  kind: string;
  message: string;
}

export interface ApprovalRequest {
  sessionId: string;
  callId: string;
  toolName: string;
  reason: string;
  createdAt: number;
}

export interface TurnRecord {
  kind: string;
  seq?: number;
  at?: number;
  data?: Record<string, unknown>;
  ignorable?: boolean;
}

export interface TurnProjection {
  kind: string;
  id?: string;
  status?: string;
  at?: number;
  records?: TurnRecord[];
}

export function runAgent(args: {
  taskId: string;
  sessionId: string;
  request: string;
  workspace: string;
  modelId: string | null;
  reasoningEffort: string | null;
}): Promise<string> {
  return invoke<string>("run_agent", {
    input: {
      task_id: args.taskId,
      session_id: args.sessionId,
      request: args.request,
      workspace: args.workspace,
      model_id: args.modelId,
      reasoning_effort: args.reasoningEffort,
    },
  });
}

export function answerApproval(
  sessionId: string,
  callId: string,
  decision: "allow" | "reject" | "cancel",
): Promise<boolean> {
  return invoke<boolean>("answer_approval", { sessionId, callId, decision });
}

export function interruptAgent(sessionId: string): Promise<boolean> {
  return invoke<boolean>("interrupt_agent", { sessionId });
}

export function setApprovalPolicy(
  sessionId: string,
  policy: "ask" | "never",
): Promise<boolean> {
  return invoke<boolean>("set_approval_policy", { sessionId, policy });
}

export function sessionEvents(
  workspace: string,
  sessionId: string,
): Promise<TurnProjection[]> {
  return invoke<TurnProjection[]>("session_events", { workspace, sessionId });
}

export function jobList(sessionId: string): Promise<unknown[]> {
  return invoke<unknown[]>("job_list", { sessionId });
}
