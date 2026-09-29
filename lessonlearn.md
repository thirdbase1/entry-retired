# Entry Desktop — Lessons Learned

This file is a living engineering journal.

It should record what we discover while building Entry Desktop: facts, failed assumptions, architectural corrections, implementation traps, and decisions that should influence future work.

Do not turn this into a generic changelog. A changelog says **what changed**. This file should explain **what we learned and why it matters**.

---

## 2026-09-29 — Plugin-first architecture

### Lesson 1: Desktop capabilities should be plugins

The desktop should treat replaceable capabilities as plugins.

The core should understand capabilities, lifecycle, permissions, tasks, and events—not every implementation.

This lets us swap sandbox providers, model providers, terminals, storage, MCP transports, execution backends, Git integrations, indexing systems, and optional UI capabilities without rewriting the harness.

The agent should request a capability such as `execute_command`, while the registry resolves the implementation.

Plugin permissions also create an explicit security boundary for capabilities such as filesystem access, process spawning, networking, credentials, and Git writes.

---

## 2026-09-29 — Starting point

### Lesson 1: Entry Desktop should not begin as a rewrite of Entry Web

Entry's existing web application already contains substantial production behavior around agents, models, tools, MCP, approvals, sandboxes, and workflow execution.

The first desktop implementation therefore should not copy everything or rewrite everything.

**What this changes:**

We treat `entry-agents` as the behavioral reference and `entry-desktop` as the native runtime project.

The desktop project will introduce native boundaries gradually.

---

## 2026-09-29 — Native language decision

### Lesson 2: Rust is most useful where the operating system is involved

The important desktop problems are process management, terminals, filesystem access, subprocess supervision, permissions, cancellation, and native lifecycle management.

These are not primarily UI problems.

Rust + Tauri gives us a natural boundary:

```
React / TypeScript
        ↕
     Tauri IPC
        ↕
Rust native runtime
        ↕
Operating system
```

This lets the UI stay productive without forcing the whole product to become Rust immediately.

---

## 2026-09-29 — Compatibility over purity

### Lesson 3: The best architecture is not necessarily the architecture with one language

It is tempting to say:

> "The desktop agent should be written entirely in Rust."

That would make the migration unnecessarily large.

Entry already has a TypeScript ecosystem and existing agent behavior.

The better strategy is:

- keep TypeScript where it is already valuable,
- put OS-sensitive responsibilities in Rust,
- create explicit interfaces between them,
- move logic only when the native runtime provides a real advantage.

This is a migration strategy, not a language loyalty decision.

---

## 2026-09-29 — Sandbox architecture

### Lesson 4: Sandbox must be a capability abstraction

Entry already has a sandbox package.

That is valuable because the desktop should not invent a new mental model where the agent assumes a particular vendor.

The desired abstraction is:

```
Sandbox
├── local
├── Vercel
├── Boat
└── Modal
```

The agent should request capabilities rather than know which vendor provides them.

This also matters because different sandbox providers can have different:

- persistence,
- startup latency,
- filesystem semantics,
- network behavior,
- lifetime,
- resource limits,
- cost models.

A provider-specific assumption inside the agent becomes technical debt.

---

## 2026-09-29 — Process lifecycle

### Lesson 5: Command execution is not the same as process management

A naive implementation can execute:

```
command → output → exit
```

A coding agent needs more.

Real development includes:

- development servers,
- watch processes,
- test runners,
- package managers,
- child processes,
- interactive commands,
- long-running background tasks.

Therefore the native runtime must eventually know:

- which task owns a process,
- how to stream output,
- how to cancel it,
- how to terminate children,
- what happens when the application closes,
- how to recover after a crash.

This is one of the strongest reasons for a native runtime.

---

## 2026-09-29 — PTY

### Lesson 6: A real terminal is a first-class capability

An agent that only receives buffered command output will eventually hit limitations.

Interactive development tools need:

- input,
- output,
- resize,
- signals,
- persistent sessions.

Therefore the terminal layer should eventually be PTY-based rather than a collection of one-shot shell commands.

This should be implemented after basic process execution is understood, not before.

---

## 2026-09-29 — Agent state

### Lesson 7: React state cannot be the source of truth for long-running agent tasks

A task can outlive the current UI component.

It can also outlive:

- a tab,
- a route,
- a temporary network connection,
- a renderer reload.

Therefore task state belongs in the runtime/persistence layer.

The UI should observe task state.

It should not own the task.

Conceptually:

```
Runtime owns task
       ↓
UI observes task
       ↓
UI sends user intent
       ↓
Runtime mutates task
```

---

## 2026-09-29 — Security

### Lesson 8: Desktop power increases the security responsibility

A remote sandbox naturally limits what the agent can touch.

A desktop agent potentially has access to the user's real machine.

That changes the threat model.

Native capabilities must therefore be explicit.

Potential high-risk operations include:

- arbitrary shell execution,
- credential access,
- network access,
- deleting files,
- system configuration,
- Git publishing,
- installing software.

The architecture should make these capabilities visible and enforceable rather than hiding them behind generic "execute" calls.

---

## 2026-09-29 — MCP

### Lesson 9: MCP servers are processes too

An MCP connection is not only a protocol abstraction.

When an MCP server runs locally, there is a real process behind it.

That process needs:

- startup,
- health state,
- stdout/stderr handling,
- ownership,
- restart behavior,
- shutdown,
- permission policy.

Therefore MCP management belongs close to process management.

---

## 2026-09-29 — GitHub Actions

### Lesson 10: CI should prove the architecture is buildable

The repository now has separate CI checks for:

- TypeScript typechecking/build,
- Rust formatting,
- Rust compilation,
- Rust tests.

The release workflow builds Windows, Linux, and macOS artifacts from version tags.

Signing and notarization are deliberately deferred until distribution credentials and release requirements are defined.

This keeps the first pipeline useful without pretending production signing is already configured.

---

## 2026-09-29 — First vertical slice

### Lesson 11: Prove the native boundary early

The initial `native_status` command is intentionally tiny.

It proves:

```
React
  ↓
Tauri IPC
  ↓
Rust
  ↓
Response
  ↓
React
```

That may look trivial, but it validates the most important structural assumption before we build hundreds of lines on top of it.

The next work should build real capability on this boundary.

---

# Future lesson template

When discovering something important, add:

## YYYY-MM-DD — Short title

### What happened

Describe the observation.

### Why it happened

Explain the technical cause rather than only describing the symptom.

### What we learned

State the reusable lesson.

### Decision

Record what should change.

### Consequence

Explain what future work must now account for.

---

# Lessons we must actively test

These are hypotheses until verified by real implementation:

- Can Rust process management reliably own process trees on Windows?
- Which PTY implementation gives the best Windows/Linux/macOS behavior?
- What is the cleanest IPC contract between the Rust harness and TypeScript UI?
- Should model orchestration remain TypeScript initially?
- How should task state be persisted locally?
- How should approvals survive application restarts?
- What is the minimum capability set for a useful local sandbox?
- How should local and remote sandbox backends expose different capabilities?
- How should MCP child processes be restarted?
- How should credentials be isolated from arbitrary agent commands?
- How should task cancellation propagate through model calls, tools, subprocesses, and MCP?
- How should desktop builds be signed and auto-updated?
- Which Entry web behaviors must remain identical between web and desktop?

These questions should be answered by experiments and real tasks, not architecture speculation.

---

# Current principle

When uncertain, prefer:

**small experiment → observe → document → standardize → scale**

over:

**large rewrite → assumptions → debugging everything at once.**


## 2026-09-29 — Local system is the default sandbox

### Lesson
The user's local machine is the default execution environment. Desktop is not a cloud-sandbox client wrapped in a desktop window.

Cloud sandboxes are disabled by default and must never become an automatic fallback when local execution fails.

### Approval lifecycle
Approval covers the whole request lifecycle: request → task → backend → workspace/policy → model action → validation → approval → execution → observation → audit → state → next action.

Approvals are bound to the execution context and are re-evaluated when the backend changes. Cloud provisioning cannot happen merely because local execution failed.

### Decision
Make execution backend identity part of every task and operation, with local as the default. Keep remote sandbox provisioning explicitly opt-in.
