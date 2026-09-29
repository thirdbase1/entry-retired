# AGENTS.md

This is the operating contract for AI coding agents working in Entry Desktop.

## Upstream Entry reference

Entry Desktop is the native continuation of Entry Agent. Use the existing repository as the behavioral and implementation reference:

- Repository: https://github.com/thirdbase1/entry-agents
- Branch: main

Before inventing agent behavior, inspect upstream for proven implementations, prompts/system instructions, tool descriptions, context rules, approval behavior, MCP behavior, sandbox abstractions, and lessons learned.

Important upstream documents:
- AGENTS.md
- docs/agents/architecture.md
- docs/agents/code-style.md
- docs/agents/lessons-learned.md

## System prompt and behavior

When Desktop needs a system prompt, context instruction, tool-use instruction, approval rule, or agent-loop behavior that already exists in Entry Agent:

1. Search thirdbase1/entry-agents first.
2. Understand the source and why it exists.
3. Reuse compatible behavior.
4. Adapt web/cloud-sandbox-specific parts for native Desktop.
5. Record meaningful divergence in lessonlearn.md.

Do not blindly copy web-specific infrastructure. Desktop has different filesystem, process, credential, permission, and lifecycle boundaries.

## Plugin-first rule

Everything that can be isolated behind a stable capability contract should be a plugin.

Examples: agent, model/provider, tool, MCP, sandbox, workspace, terminal/PTY, storage, Git/integration, and optional UI plugins.

The core should own contracts, registration, lifecycle, permissions, task state, events, and IPC—not every implementation.

## Development rules

- Inspect existing code before changing it.
- Prefer focused modules.
- Never use any; use unknown and narrow it.
- Keep OS responsibilities in Rust.
- Keep agent/model layers replaceable.
- UI is not the source of truth for long-running tasks.
- Every long-running process needs ownership, cancellation, and cleanup.
- Dangerous capabilities require explicit permission/approval boundaries.
- Prefer small vertical slices that build and test.
- Update lessonlearn.md when a non-obvious behavior is discovered.

## Compatibility

Preserve useful Entry Agent behavior where practical, while replacing web-only infrastructure with native capabilities. Do not duplicate existing behavior without first understanding the upstream implementation.
