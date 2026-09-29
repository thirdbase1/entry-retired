// Native bridge — typed wrappers over Tauri IPC commands.
// The UI never constructs IPC details directly; it goes through this module
// so the capability boundary stays explicit, and mirrors the Rust contracts.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Upstream `ExecResult` shape: success/exitCode/stdout/stderr/truncated. */
export interface BashResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ReadResult {
  path: string;
  /** Already wrapped by the untrusted-content boundary on the Rust side. */
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset: number | null;
}

export interface WorkspaceInfo {
  root: string;
  isGitRepo: boolean;
  gitBranch: string | null;
  hasPackageJson: boolean;
  hasCargoToml: boolean;
}

export function nativeStatus(): Promise<string> {
  return invoke<string>("native_status");
}

/** Set the workspace root (Rust canonicalizes and owns it). */
export function setWorkspace(path?: string): Promise<string> {
  return invoke<string>("set_workspace", { path: path ?? null });
}

/** Upstream-compatible bash. `cwd` must be workspace-relative. */
export function bash(command: string, cwd?: string): Promise<BashResult> {
  return invoke<BashResult>("bash", { command, cwd: cwd ?? null });
}

/** Read a workspace file through the three ceilings + content boundary. */
export function readFile(
  path: string,
  offset?: number,
  limit?: number
): Promise<ReadResult> {
  return invoke<ReadResult>("read_file", {
    path,
    offset: offset ?? null,
    limit: limit ?? null,
  });
}

/** True when the runtime would refuse the command as dangerous. */
export function commandApprovalRequired(command: string): Promise<boolean> {
  return invoke<boolean>("command_approval_required", { command });
}

export function workspaceInfo(path?: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("workspace_info", { path: path ?? null });
}

export function cancelProcess(): Promise<boolean> {
  return invoke<boolean>("cancel_process");
}

/** Subscribe to live process output events from the Rust core. */
export async function onProcessOutput(
  cb: (stream: "stdout" | "stderr", text: string) => void
): Promise<UnlistenFn> {
  const off1 = await listen<{ handle: number; stream: string; text: string }>(
    "process:stdout",
    (e) => cb("stdout", e.payload.text)
  );
  const off2 = await listen<{ handle: number; stream: string; text: string }>(
    "process:stderr",
    (e) => cb("stderr", e.payload.text)
  );
  return () => {
    off1();
    off2();
  };
}
