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

## 2026-09-30 — Phase 1: native execution
### Lesson 12: Streaming output needs a reader thread + polling wait loop
A one-shot `child.wait()` blocks and cannot poll a cancel flag. The working pattern: drain stdout/stderr on reader threads through a channel, poll `try_wait()` every 50ms, kill on cancellation, then do a final drain. Per-line events go to the UI via Tauri `emit` on `process:*` channels.

### Lesson 13: Tauri commands that supervise processes must be `async` + `spawn_blocking`
A synchronous `#[tauri::command]` runs on the main thread; a long-running child freezes the app and blocks cancellation. Mark the command `async` and move child supervision into `tauri::async_runtime::spawn_blocking`.

### Lesson 14: Tauri state cannot be moved into spawn_blocking
`State<'_, T>` borrows and cannot cross into a spawned task. Clone cheap inner handles (the executor is just an atomic counter behind Arc) or use `app.state::<T>()` inside the task with an owned `AppHandle`.

### Lesson 15: generate_context! fails at compile time without icons
tauri.conf.json bundling with an empty icon list and no icons on disk breaks `cargo check` with a proc-macro panic about a missing icon.png, not a normal compile error. Generate icons early (`pnpm tauri icon`).

### Lesson 16: Tauri 2 emit signature
`Emitter::emit` takes `&str`, so an owned `String` event name needs `&name`. The generic form is `emit<R: Runtime>(app: &AppHandle<R>, ...)` to stay testable outside the concrete runtime.

## 2026-09-30 — Phase 1: upstream-compatible tool boundaries

Lesson 17: Desktop tools must reuse upstream Entry's contracts, not reinvent them
Building bash/read from scratch produced generic, weaker tools. Inspecting
`entry-agents/packages/agent/tools/*` gave the proven contracts: workspace-only
relative `cwd`, narrow destructive-command approval patterns, the
`<external_file_content>` boundary wrapper, and the three read ceilings
(2000 lines / 128KB / 2000 chars per line). Ported to Rust rather than
duplicated: `path_security.rs`, `approval.rs`, `content_boundary.rs`,
`read_ceilings.rs`. AGENTS.md's "inspect upstream before inventing" rule is
enforced by doing exactly that as the first step, not the last.

Lesson 18: Capture upstream's bug fixes, not just its features
`selectLines` carries a fix for past-EOF offsets producing an inverted range
(startLine 50, endLine 10 on a 10-line file); `splitLines` exists because
`split("\n")` leaves a phantom trailing entry that makes `totalLines` one too
high. Porting the helpers without reading their comments would have
reintroduced both bugs. Port tests alongside the code so the fixes come with
them.

Lesson 19: A word-boundary regex cannot match `/.ssh`
Upstream's `SENSITIVE_FILE_PATTERNS` includes `\.ssh\b`, which never matches
`~/.ssh/config` — there is no word boundary between `/` and `.`. On web Entry
the credential risk is a cloud sandbox; on Desktop the agent touches the real
home directory, so the gap matters more. Divergence: match the directory with
an explicit separator (`(?:^|[\s/\\])\.ssh(?:$|[\s/\\])`) and record it here.
Deliberate divergence from upstream, logged per AGENTS.md.

Lesson 20: `^/dev/[^/]+$` is what catches block devices
An allowlist of known device names (`null`, `zero`, `random`, …) misses
`/dev/sda`. Upstream's third alternative matches any single-segment `/dev/<x>`.
Porting only the allowlist silently weakened the guard; the test
(`is_device_path("/dev/sda")`) caught it.

Lesson 21: Integration tests can exercise the executor without a Tauri runtime
`Executor::run` is generic over `R: Runtime`, but the boundary pipeline
(cwd gate → approval gate → spawn → timeout) is testable directly with
`std::process::Command`. `tests/bash_pipeline.rs` covers escaping cwd refusal,
subdirectory execution, real timeout kills, and layer independence — no app
instance required.

Lesson 22: Approval must be enforced in the runtime, not the UI
`command_approval_required` is exposed so the UI can warn *before* running, but
`bash` refuses dangerous commands server-side regardless of what the caller
asks. A UI-only gate would be bypassable by any future IPC caller, which
contradicts goal.md §13 ("the runtime decides").

Lesson 23: Timeout semantics belong to the executor, not the caller
Upstream's bash timeout is kill-and-report-failure, not "stop waiting". The
executor's `run` takes `Option<u64>` and kills the child on expiry, returning
`exitCode: null` plus `Command timed out after <n>ms` on stderr. Putting the
deadline in the wait loop (not a separate timer thread) keeps cancellation and
timeout on one code path.

## Lessons 24-33 — Phase 2: workspace as capability + process manager

24. **Lexical resolution is not containment.** A workspace-relative path that resolves inside the root can still be a symlink pointing outside. `gate_read` canonicalizes (follows links) and re-checks `is_path_within_directory` on the canonical result. A test with a real symlink caught this.
25. **Registered state must be re-verified at every gate entry.** The root can vanish (unmount, rm -rf) between registration and use. Both gates call `verify()` first; the test deletes the root mid-flight and asserts refusal.
26. **Split the process supervisor from event emission.** `spawn_recorder` runs the full lifecycle with no `AppHandle`; `spawn` wraps it with `process:*` events. Lifecycle is testable without a running Tauri app.
27. **Process output is both streamed and captured.** The supervisor drains the reader channel while polling and accumulates stdout/stderr into the final `ProcessRecord`.
28. **`State<'_, AppState>` cannot cross into `spawn_blocking`** — clone the Arc-backed manager before the `move` closure.
29. **Pipe types must be unified** (`Box<dyn Read + Send>`) when iterating stdout/stderr pairs (Lesson 14 recurring).
30. **Task → process association is the cleanup primitive**: `handles_for_task` + `cancel_task` = "kill everything a task owns".
31. **Real timeout tests must assert wall-clock**, not just reported state: `sleep 30` @ 300ms timeout must return <10s.
32. **Deny-by-default writes**: `gate_write` refuses everything in Phase 2; the policy hook exists for Phase 3+.
33. **Test argument-order bugs mimic real ones.** Two "failures" were the test calling `is_path_within_directory(dir, file)`; a probe example confirmed the function before touching it.


## Native agent runtime checkpoint — 2026-09-29

Entry Desktop has moved from the window foundation into a working local-first agent vertical slice. The runtime now has a real plugin registry, a local execution plugin, a replaceable OpenAI-compatible model plugin, bounded model-network retries, persisted task state under `.entry/tasks/`, and native tool execution on the user's machine.

The reconnect policy is task-state based: transient model/network failures are retried with bounded backoff, and if the request still fails, the task state remains persisted so a later run can resume instead of rebuilding the task from scratch. Cloud sandboxes are not used as a fallback.

This is deliberately not a full reproduction of the web runtime. Desktop owns the native execution boundary while reusing Entry's proven behavioral contracts and system-prompt principles.
