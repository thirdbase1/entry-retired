# Entry Desktop — Goal & Engineering Contract

## Current scope — Window only

For the current development stage, Entry Desktop is **window-only**. The immediate focus is the native desktop window foundation: Tauri 2, React + TypeScript, Rust native core, Tauri IPC, and CI/release builds.

We are deliberately **not implementing the agent harness, local sandbox, cloud sandboxes, plugin runtime, terminal, MCP, approvals, or workspace execution yet**. Those remain architectural goals for later phases.


> This document is the source of truth for what Entry Desktop is trying to become, why the architecture is shaped this way, and what we are deliberately **not** doing yet.

## 1. The goal

Build a native desktop version of Entry that is not simply the Entry website packaged inside a desktop window.

The desktop product should eventually make the user's computer a first-class execution environment for the agent.

That means the desktop application should be able to:

1. Open a local workspace.
2. Understand the workspace and its Git state.
3. Start and supervise processes.
4. Provide a real terminal/PTY to the agent.
5. Read and write files through controlled native APIs.
6. Run tests, linters, builds, package managers, and developer tools.
7. Connect to MCP servers and supervise their processes.
8. Ask for user approval before dangerous or sensitive operations.
9. Maintain durable local task state.
10. Create checkpoints/snapshots so long-running work can recover.
11. Run an agent loop locally while still using remote or local models.
12. Make sandbox execution a replaceable backend rather than a Vercel-specific assumption.
13. Keep the UI responsive while the native runtime performs long-running work.
14. Recover from crashes and interrupted tasks.
15. Eventually expose a powerful local harness that can operate independently of the Entry web application.

The end state is an **agent-native desktop runtime**.

The UI is important, but it is not the core idea.

The core idea is:

```
Desktop App
    ↓
Native Runtime
    ↓
Agent Harness
    ↓
Tools / MCP / Workspace / Processes
    ↓
Real Computer
```

## 2. Why this repository exists separately

Entry's existing web application already contains substantial agent logic, provider integration, sandbox abstraction, MCP support, approvals, and product behavior.

That code should not be blindly copied into this repository.

The desktop repository exists to establish a clean native boundary.

The existing Entry application remains the reference implementation for behavior. Entry Desktop becomes the native implementation of capabilities that benefit from direct access to the operating system.

The initial strategy is therefore **compatibility first, replacement second**.

We should preserve working behavior while gradually moving responsibilities into native components.

## 3. The architecture

The intended architecture is:

```
┌─────────────────────────────────────────────┐
│                 Entry Desktop               │
├─────────────────────────────────────────────┤
│ React / TypeScript UI                       │
│                                             │
│ Chat · Tasks · Workspace · Terminal · UI    │
└──────────────────────┬──────────────────────┘
                       │ Tauri IPC
┌──────────────────────▼──────────────────────┐
│                 Rust Core                   │
├─────────────────────────────────────────────┤
│ Harness                                     │
│  ├─ task lifecycle                          │
│  ├─ model/tool orchestration boundary       │
│  ├─ context/state                           │
│  └─ approval policy                         │
│                                             │
│ Executor                                    │
│  ├─ processes                               │
│  ├─ terminal / PTY                          │
│  ├─ filesystem                              │
│  └─ environment                             │
│                                             │
│ Workspace                                   │
│  ├─ files                                   │
│  ├─ git                                     │
│  ├─ checkpoints                             │
│  └─ task state                              │
│                                             │
│ MCP                                         │
│  ├─ client                                  │
│  ├─ server                                  │
│  └─ child-process supervision               │
│                                             │
│ Sandbox                                     │
│  ├─ local                                  │
│  ├─ Vercel                                  │
│  ├─ Boat                                    │
│  └─ Modal                                   │
└──────────────────────┬──────────────────────┘
                       │
                Models / Network
```

The important architectural rule is that the agent should depend on **capabilities**, not on a particular execution provider.

For example, the harness should ask for:

- execute command
- read file
- write file
- inspect git
- start process
- connect MCP server
- create checkpoint

It should not care whether execution happens in a local process, Vercel Sandbox, Boat, Modal, or another backend.

## 4. Everything is a plugin

**Core architectural rule: if a capability can be isolated behind a stable interface, it should be a replaceable plugin.**

Entry Desktop should not become one giant native implementation. The core stays small and orchestrates capabilities.

Conceptually:

```
Entry Desktop Core
├── UI plugins
├── Agent plugins
├── Model plugins
├── Tool plugins
├── MCP plugins
├── Sandbox plugins
├── Workspace plugins
├── Terminal plugins
├── Storage plugins
└── Integration plugins
```

Examples include Local/Vercel/Boat/Modal sandbox plugins, remote/local model plugins, terminal implementations, storage implementations, MCP transports, Git providers, indexing/search engines, authentication integrations, and optional UI panels.

The plugin boundary defines **capabilities and contracts**, not implementation details.

A plugin should be independently replaceable, explicitly registered, capability-described, permission-aware, observable, testable, lifecycle-aware, and versionable where necessary.

### What stays core?

Keep the core as small as possible:

- plugin registry
- capability model
- task lifecycle
- event model
- permission/approval policy
- IPC boundary
- configuration
- plugin lifecycle

### Plugin lifecycle

```
discovered → validated → registered → initialized → ready → running → stopped
```

Plugins that start processes, open sockets, allocate resources, or create subscriptions must have cleanup semantics.

### Plugin permissions

Plugins must declare capabilities such as:

```
filesystem.read
filesystem.write
process.spawn
network.connect
credentials.read
git.write
mcp.start
```

The runtime decides whether those capabilities are allowed. Plugin architecture must not become an unrestricted escape hatch.

### Plugin-first development rule

For every new feature ask:

1. Does this genuinely need to be core?
2. Can it be a plugin?
3. What capability contract does it need?
4. What permissions does it require?
5. What lifecycle does it have?
6. Can another implementation replace it?
7. Can the harness work without it?

If the feature can operate independently, that is strong evidence it belongs outside the core.

---

## 5. The first implementation

The first implementation is intentionally small:

- Tauri 2 shell.
- React + TypeScript UI.
- Rust native core.
- A working Rust → UI command.
- GitHub Actions for typecheck/build/Rust checks.
- GitHub Actions release workflow for Windows, Linux, and macOS.
- Documentation describing the target architecture.

This is a foundation, not the finished agent.

The native status command exists as a deliberate vertical slice: the UI can prove that it is communicating with native Rust rather than merely rendering a browser application.

## 5. Why Rust is the native language

Rust is being chosen for the native core because the difficult part of a desktop agent is not rendering the UI.

The difficult part is safely managing:

- processes,
- streams,
- terminals,
- files,
- concurrency,
- cancellation,
- permissions,
- subprocesses,
- native operating-system APIs,
- crash boundaries,
- long-running tasks.

Rust provides a strong model for these responsibilities and integrates naturally with Tauri.

Rust is **not** being chosen because every piece of the application must be rewritten in Rust immediately.

That would create unnecessary migration risk.

The intended split is:

- TypeScript: product UI and early compatibility layer.
- Rust: native execution and increasingly the durable agent runtime.

## 6. Why not rewrite Entry's agent runtime immediately?

Entry already works around an existing TypeScript ecosystem.

The web application uses AI SDK-related components, Open Agents packages, sandbox abstractions, MCP tooling, provider integrations, workflow infrastructure, and application-specific behavior.

A complete rewrite before understanding every dependency would create two problems:

### Problem A — behavioral drift

The desktop agent could become a different agent from the web agent.

### Problem B — migration cost

We would spend days reproducing infrastructure instead of learning which parts genuinely need to become native.

The correct sequence is:

```
Existing Entry behavior
        ↓
Identify runtime boundaries
        ↓
Native capability interfaces
        ↓
Move one capability at a time
        ↓
Validate against real tasks
        ↓
Move more runtime responsibility
```

## 7. The agent harness

The eventual harness should behave approximately like:

```
User task
   ↓
Create task
   ↓
Inspect workspace
   ↓
Build context
   ↓
Ask model for next action
   ↓
Validate requested tool
   ↓
Approval policy
   ↓
Execute tool
   ↓
Capture output
   ↓
Update task state
   ↓
Feed observation back to model
   ↓
Repeat
   ↓
Run verification
   ↓
Review result
   ↓
Produce final response
```

The harness must treat every step as stateful.

A task should not exist only inside a React component.

A task should have an identifiable state that can survive:

- UI navigation,
- temporary model failure,
- process failure,
- application restart,
- network failure,
- user interruption.

## 8. Task state

The future task model should include concepts such as:

```text
Task
├── id
├── user_request
├── workspace
├── status
├── current_step
├── messages
├── tool_calls
├── approvals
├── processes
├── checkpoints
├── errors
├── created_at
└── updated_at
```

The exact database/storage technology is intentionally not fixed yet.

The first requirement is durable semantics, not a premature storage decision.

## 9. Local workspace

A local workspace should eventually have an Entry-managed directory similar to:

```
workspace/
├── repo/
└── .entry/
    ├── state/
    ├── logs/
    ├── checkpoints/
    ├── approvals/
    └── processes/
```

The `.entry` directory should contain runtime metadata, not a second copy of the user's repository.

The user's source tree remains the source of truth.

## 10. Process management

Process execution is one of the main reasons the desktop runtime exists.

The native executor should eventually support:

- command execution,
- streaming stdout,
- streaming stderr,
- exit status,
- cancellation,
- timeouts,
- environment variables,
- working directory,
- process tree handling,
- process ownership,
- process cleanup.

A simple command runner is not enough.

An agent can start a development server that stays alive for hours. It can start a package manager that launches children. It can run a test suite that fails halfway through.

The runtime therefore needs explicit process ownership.

Conceptually:

```
Task
 ├── Process A
 │    ├── stdout
 │    ├── stderr
 │    └── children
 └── Process B
      ├── stdout
      └── stderr
```

When a task is cancelled, the runtime must know which processes belong to that task.

## 11. Terminal / PTY

A real coding agent eventually needs a PTY rather than only `Command::output()`.

The terminal layer should eventually provide:

- interactive shells,
- streaming output,
- input,
- resize,
- signals,
- cancellation,
- terminal lifecycle.

This enables workflows such as:

```
agent → shell → dev server
agent → shell → git
agent → shell → package manager
agent → shell → test runner
```

The UI can display the terminal, but Rust should own the process lifecycle.

## 12. MCP

MCP should be treated as a protocol boundary.

The desktop runtime should eventually be able to:

1. Start an MCP server process.
2. Connect to it.
3. Discover tools/resources/prompts.
4. Expose those capabilities to the harness.
5. Track the process.
6. Shut it down cleanly.
7. Apply permission policy.

MCP servers should not be allowed to become an untracked collection of arbitrary background processes.

The MCP manager therefore belongs close to the native process manager.

## 13. Approvals and security

The desktop version will have more power than the web sandbox.

That makes approval policy more important, not less.

Potentially sensitive operations include:

- deleting files,
- changing files outside the workspace,
- installing system software,
- running network commands,
- accessing credentials,
- spawning unrestricted processes,
- modifying shell configuration,
- changing Git history,
- publishing code,
- interacting with external services.

The rule is:

> Native power must be paired with explicit capability boundaries.

Do not give the model unrestricted operating-system authority merely because the desktop application technically can.

## 14. Sandbox abstraction

The existing Entry code already has a sandbox abstraction.

Desktop should extend that idea rather than create a second incompatible concept.

Target:

```
Sandbox
├── LocalDesktopSandbox
├── VercelSandbox
├── BoatSandbox
└── ModalSandbox
```

The harness should interact with the abstraction.

Each backend should provide the capabilities it actually supports.

This prevents an important failure mode where the agent assumes every sandbox has the same lifecycle or persistence model.

## 15. Model architecture

Desktop should not require a model to run locally.

The first version should support the same general provider strategy as Entry:

```
Desktop
  ↓
Model provider
  ↓
Remote model
```

Later, local models can become another provider:

```
Desktop
  ↓
Model interface
  ├── Remote provider
  ├── Local HTTP provider
  └── Local embedded runtime
```

This is important because the desktop's native resources can improve execution without forcing a local LLM.

The machine can provide the compute for:

- code execution,
- indexing,
- search,
- embeddings,
- tests,
- builds,
- terminal sessions,
- workspace analysis.

The model can remain remote.

## 16. UI goal

The desktop UI should eventually be designed around tasks and runtime state rather than copying the website pixel-for-pixel.

Potential primary surfaces:

- workspace selector,
- task/chat view,
- execution timeline,
- live terminal,
- changed files,
- diff/review,
- approvals,
- process monitor,
- MCP/tool status,
- task checkpoints,
- agent settings.

The desktop application should feel like a developer workstation with an agent built into it.

## 17. GitHub Actions goal

Every push should be mechanically checked.

Pull requests should validate:

- TypeScript,
- frontend build,
- Rust formatting,
- Rust compilation,
- Rust tests.

Tagged releases should build desktop artifacts for:

- Windows,
- Linux,
- macOS.

Signing and notarization are intentionally a later stage because they require platform-specific credentials and secrets.

The pipeline should evolve toward:

```
push
 ↓
CI
 ↓
tests
 ↓
build
 ↓
tag
 ↓
release builds
 ↓
sign
 ↓
notarize
 ↓
publish
```

## 18. Development phases

### Phase 0 — Foundation

Current phase.

- Tauri shell.
- React UI.
- Rust core.
- Native IPC.
- CI.
- Release workflow.
- Architecture documentation.

### Phase 1 — Native execution

Build:

- command execution,
- streaming process output,
- cancellation,
- filesystem APIs,
- workspace detection.

### Phase 2 — Terminal

Build:

- PTY,
- interactive shell,
- terminal UI,
- process ownership.

### Phase 3 — Workspace intelligence

Build:

- Git integration,
- changed-file tracking,
- checkpoints,
- task state.

### Phase 4 — MCP

Build:

- MCP client,
- server process manager,
- tool discovery,
- lifecycle management,
- permissions.

### Phase 5 — Agent harness

Build:

- task state machine,
- model/tool loop,
- tool validation,
- approvals,
- cancellation,
- retries,
- recovery.

### Phase 6 — Entry compatibility

Map existing Entry behavior onto the native runtime.

At this stage, we should be able to compare real tasks between web Entry and Desktop Entry.

### Phase 7 — Native-first agent

Move increasingly important runtime responsibilities out of the web compatibility layer.

### Phase 8 — Distribution

Add:

- signed Windows builds,
- signed/notarized macOS builds,
- Linux packages,
- update strategy,
- crash reporting,
- diagnostics.

## 19. Definition of success

The project is successful when Entry Desktop can take a real software-engineering task and complete it against a local repository without pretending the local machine is a remote web sandbox.

A meaningful milestone is:

> Give Entry Desktop a repository and a task. It inspects the repository, edits files, runs commands, runs tests, shows the work, asks for approval when necessary, and returns a verifiable result.

The final quality bar is not how impressive the UI looks.

It is whether the harness can safely and reliably drive real development work.

## 20. Rules for future contributors

1. Do not add a native capability directly to React if Rust should own its lifecycle.
2. Do not make the Rust core depend on UI state.
3. Do not couple the harness to one sandbox provider.
4. Do not duplicate existing Entry behavior without understanding why it exists.
5. Do not rewrite working TypeScript infrastructure merely for language purity.
6. Do not add a database before the state model is understood.
7. Do not give tools unrestricted host access by default.
8. Every long-running process needs ownership and cleanup semantics.
9. Every dangerous capability needs an explicit policy boundary.
10. Every architectural discovery belongs in `lessonlearn.md`.
11. Prefer small vertical slices over huge rewrites.
12. A feature is not finished until it is observable, cancellable, and testable.

## 21. The long-term idea

Entry Desktop should eventually make this possible:

```
"Build this feature in my repository."
                 ↓
        Entry Desktop
                 ↓
       Native Agent Harness
                 ↓
       ┌─────────┴─────────┐
       ↓                   ↓
   Local machine       Model provider
       ↓                   ↓
 files / git / shell    reasoning
 terminal / tools
       └─────────┬─────────┘
                 ↓
          verified result
```

That is the product.

Not a desktop wrapper.

A real local execution environment for an AI software engineer.


## 23. Local-first execution and approval lifecycle

The user's local system is the default sandbox. A workspace opened in Desktop executes locally unless the user explicitly selects another backend.

Cloud sandboxes are OFF by default. Vercel, Boat, Modal, or future remote sandbox plugins must never silently become a fallback when local execution fails, times out, or is unavailable. Provisioning or switching to a cloud sandbox is an explicit, policy-checked action.

Every task owns an execution backend: local, vercel, boat, modal, or another registered plugin. The backend is part of task state and audit history.

The complete request lifecycle is:

user request → create task → select backend → resolve workspace and policy → model proposes action → validate capability, target and backend → approval check → execute → stream observation → record result/audit event → update task state → continue or finish.

Approval is not merely a boolean on a tool. It evaluates the capability, target, workspace, execution backend, task policy, and current lifecycle state. If the backend changes, approval is re-evaluated. Local approval never silently authorizes a cloud operation.

If local execution fails, the runtime pauses or fails according to policy. It does not automatically provision a paid or remote sandbox.

## UI quality bar

Entry Desktop must have a deliberate, premium UI from the beginning. The window-only phase is not permission to ship a generic Tauri starter interface.

The visual direction should be:

- minimal, premium, and sharp
- dark-first
- strong Entry visual identity
- intentional typography and spacing
- clear hierarchy
- subtle, purposeful motion
- polished states and transitions
- no generic dashboard/template aesthetic
- no unnecessary UI chrome
- designed as a serious developer tool, not a web app wrapped in a window

UI quality is part of the product foundation. We should establish the visual system early rather than bolt polish onto a feature-heavy interface later.
