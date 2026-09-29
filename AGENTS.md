# AGENTS.md

This is the operating contract for AI coding agents working in Entry Desktop.

## Canonical upstream Entry repository

Entry Desktop is the native continuation of Entry Agent.

**Canonical repository URL:** https://github.com/thirdbase1/entry-agents  
**Repository:** `thirdbase1/entry-agents`  
**Default branch:** `main`

Treat `https://github.com/thirdbase1/entry-agents` as the explicit upstream source when Desktop needs to reuse or understand existing Entry behavior. Do not rely on the repository name alone.

Before inventing agent behavior, inspect the canonical upstream repository for proven implementations, prompts/system instructions, tool descriptions, context rules, approval behavior, MCP behavior, sandbox abstractions, and lessons learned.

Important upstream documents:
- https://github.com/thirdbase1/entry-agents/blob/main/AGENTS.md
- https://github.com/thirdbase1/entry-agents/tree/main/docs/agents
- https://github.com/thirdbase1/entry-agents/blob/main/docs/agents/architecture.md
- https://github.com/thirdbase1/entry-agents/blob/main/docs/agents/code-style.md
- https://github.com/thirdbase1/entry-agents/blob/main/docs/agents/lessons-learned.md

## How to use the upstream repository

When Desktop needs a system prompt, context instruction, tool-use instruction, approval rule, or agent-loop behavior that already exists in Entry Agent:

1. Open and inspect the canonical repository: https://github.com/thirdbase1/entry-agents
2. Search its code and documentation before designing a new behavior.
3. Identify the actual implementation and understand why it exists.
4. Reuse compatible behavior rather than recreating it from memory.
5. Adapt web/cloud-sandbox-specific parts for native Desktop.
6. Record meaningful divergence in `lessonlearn.md`.

Do not blindly copy web-specific infrastructure. Desktop has different filesystem, process, credential, permission, and lifecycle boundaries.

## Plugin-first rule

Everything that can be isolated behind a stable capability contract should be a plugin.

Examples: agent, model/provider, tool, MCP, sandbox, workspace, terminal/PTY, storage, Git/integration, and optional UI plugins.

The core should own contracts, registration, lifecycle, permissions, task state, events, and IPC—not every implementation.

## Development rules

- Inspect existing code before changing it.
- Prefer focused modules.
- Never use `any`; use `unknown` and narrow it.
- Keep OS responsibilities in Rust.
- Keep agent/model layers replaceable.
- UI is not the source of truth for long-running tasks.
- Every long-running process needs ownership, cancellation, and cleanup.
- Dangerous capabilities require explicit permission/approval boundaries.
- Prefer small vertical slices that build and test.
- Update `lessonlearn.md` when a non-obvious behavior is discovered.

## Compatibility

Preserve useful Entry Agent behavior where practical, while replacing web-only infrastructure with native capabilities. Do not duplicate existing behavior without first understanding the upstream implementation.

- Local execution is the default sandbox.
- Cloud sandboxes are disabled by default and never an implicit fallback.
- Every task has an explicit execution backend; backend changes are observable policy transitions.
- Approval evaluates capability, target, workspace, task policy, execution backend, and lifecycle state.
- Backend changes invalidate/re-evaluate approvals; local approval does not authorize cloud execution.
