# How dsh's Plugin System Works — and What Entry Desktop Should Port for Phase 4

## 1. The core: Cordis (vendored at `vendor/cordis/src/`)

dsh (DeepSeek Harness) is built on **Cordis** (`vendor/cordis/src/{context,fiber,events,service,registry}.ts`, pinned `4.0.0-rc.7`, `vendor/README.md` manifest table). Five ideas (docs/cordis-primer.md):

1. **A plugin is an object implementing `Service`** — a function with optional `static inject` (service deps) and an `apply(ctx)` body, or a `Service` subclass whose lifecycle the framework mounts.
2. **A context is a service repository.** Each service claims a stable `ctx.<key>` (`ctx.tools`, `ctx.llm`, `ctx.sessions`, `ctx.agents`…). Other plugins resolve by *key*, never by importing a concrete implementation.
3. **`inject` declares dependencies** — a plugin's activation waits until named services exist, so load order is emergent, not sequenced.
4. **Typed events** — events declared via TS declaration merging; dispatched as `emit` / `waterfall` / `parallel` / `serial` / `bail`. The dispatch *mode is part of the public contract*, tagged `@mode` in the source (`docs/cordis-primer.md`, dispatch table).
5. **Registrations are reversible effects** — prompt sections, tool schemas, adapters, listeners are installed via `ctx.effect()` (returning a disposer) or `ctx.on()`, so reload/unload unwinds predictably.

**Waterfall semantics** = around-middleware: a listener receives `(...args, next)`; call `next()` to delegate (the cooperative case — mutate a shared request/decision object and delegate), return *without* `next()` to short-circuit and own the decision. `prepend: true` escapes registration order. Single-decision events (e.g. `agent/pre-step`) are *designed* to short-circuit for policy owners.

Evidence: `packages/core/tools/src/index.ts:808` (`static inject = ['systemPrompt']`), `:979` (`ctx.effect(function* (this: ToolRuntime) {...})` — generator-style effects with composed disposers), `:1083/:1119/:1137` (`this.layers.effect(...)` returning exact disposers for ordered ownership).

## 2. What the minimal core owns vs what plugins own

There is **no privileged core to patch** (docs/architecture.md). Every part of the product is a plugin — model adapter, tool registry, session log, the agent loop itself. Composition is layered config, not code:

- **Profile** — a named composition in Harness home listing bundles + user's `cordis.patch.yml`. Templates: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`.
- **Bundle** — a distribution format for config rows + the code they mount; declared in package.json `dsh.bundle` pointing at a patch file. `packages/bundle/base/cordis.patch.yml` is the shared first layer (one `insert:` block; rows like `id: llm → '@deepseek-ai/dsh-llm'`, `id: hmr` with `disabled: !!js "!ctx.get('profileContext')"` — `!!js` expressions are lazily interpolated per-entry, `disabled` re-evaluated at every mount decision, `vendor/README.md` mods 15/18).
- **Patch order**: bundles in profile order → profile patch → home-level patch → `--patch` overlays. A patch targets a row by id and **replaces its whole config** (no merge), or inserts rows; last write wins per row. `dsh --profile web --dump-config` prints the exact tree, and *any row it prints can be replaced by a user patch*.

The minimal core therefore owns only: the context/fiber lifecycle (incl. disposal hardening, vendor mod 6: effect wrappers registered before setup runs, load-epoch checks, teardown failure containment), the loader/include config machinery (`vendor/include/src/index.ts` — with `applyEntryPatches` exported as a *pure* function so config tooling can't drift from the mount algorithm, mod 11), and events. Everything else — `ctx.tools`, `ctx.llm`, `ctx.sessions`, `ctx.agentLoop`, sandbox, approval, telemetry — is a plugin row.

## 3. Capability seams: definition / provider / consumer

The central design unit (docs/capability-seams.md, docs/glossary.md): a **seam** is a swappable capability with three roles —

- **Service Definition**: the Cordis `Service` owning `ctx.<key>` + vocabulary types. Always an abstract class or concrete registry, *never a TS interface* (so it carries runtime identity for the DI key).
- **Service Provider(s)**: packages registering implementations.
- **Consumer(s)**: packages injecting the key (often model-facing tools).

Canonical example — shell:
- Definition `packages/shell/shell` → `ctx.shell`
- Providers `packages/shell/bash-local`, `bash-sandbox`, `pwsh-local`
- Consumers `packages/shell/tool-bash`, `tool-pwsh`, `packages/hooks/hooks-claude-code`

Roles usually occupy separate packages but may combine (`user-approval` owns definition + implementation). *One role alone is not a seam* — adding a capability means designing all three.

The payoff: **provider swaps move the whole product**. Filesystem + subprocess + sandbox providers share one execution world, so pointing them at SSH (`ctx.ssh` → `fs-ssh`, `subprocess-ssh`, `sandbox-ssh`) relocates Bash, PTY, and LSP with no consumer forks. Same pattern for `ctx.subagents` (spawn-in-process / fork / ACP / Codex / Claude Code / SDK backends behind one interface, consumed by `tool-subagent`).

Other key seams from the catalog: `ctx.llm` (adapters; consumers = agent-loop, compaction-basic), `ctx.fs`, `ctx.sandbox` (consumers hand over exact argv; backends wrap under per-call policy), `ctx.approval` (answerers are listeners on the `approval/request` waterfall; **absence fails closed to `unavailable`**), `ctx.storage`, `ctx.credentials` (config carries *references* to secrets; providers resolve values per operation, so a rotated credential reaches the next request).

Companion non-seam services sit beside seams: controllers (`ctx.sessionController`, `api-session-controller`) project seams onto the wire; "Remote" namespaces (typert gateway, `ctx.typertGateway`) bind generated wire descriptors to live services.

## 4. Events as the extension surface

Three event domains (docs/architecture.md):
- **Session events** — durable facts in the append-only log, broadcast via `session/event`. "Model-visible means logged": a runtime invariant checks every model request is reconstructable from the log, so plugins that change model-visible content must add session events and register *pure message projections* (`ctx.sessionProjections`).
- **Agent events** (`agent/*`) — carry a live Agent (inbox, step, status, request); used to observe/intercept work in flight.
- **Capability events** (`fs/*`, `tools/*`, `telemetry/*`) — attach policy/adapters to a seam without importing the loop.

The tool pipeline is the flagship: `tools/pre-execute → tools/execute → tools/post-execute` (waterfalls) inside `tool/call*`; the registry owns "pre-policy, monotonic guards, around dispatch, post-policy, final-result observation" (capability-seams catalog note on `ctx.tools`). `agent/pre-step`, `agent/request`, `llm/stream` are waterfalls; `agent/turn-stopping` is serial (no `next()`).

## 5. Config: cordis.yml, overlays, HMR

- Plugin rows live in `cordis.patch.yml` files; the Include plugin (`vendor/include/src/index.ts`) parses `!!js` expressions, mounts entries, persists `disabled` state via debounced durable writes (mod 14), and reapplies patches after config edits (mod 8).
- Lazy config resolution (mod 15): raw fiber config resolves through `internal/config` only after declared injections activate — deferred failures keep the owning row's diagnostic.
- Volatile config (mod 22): Schemastery `.volatile()` fields commit by reference without remounting the plugin — `Entry._commitVolatile` re-parses and emits `loader/volatile-update`; ordinary changes still remount. This is how live settings edits (model selection etc.) propagate without restarts.
- `ctx.configEditor` persists profile patches under an application file lock + HMR queue; `ctx.settings` renders config forms; `ctx.pluginManager` shares profile package operations with the CLI. HMR (`ctx.hmr`) owns module/config watchers; config-only reloads are on by default, module roots opt-in.

## 6. What Entry Desktop should port into Tauri (Rust core + React TS) for Phase 4

Current state: `src-tauri/src/plugin.rs` has a flat `Plugin` trait (`id()` + `capabilities()`) and a hard-coded `PluginRegistry { local_runtime, model_provider }`. The agent loop (`src-tauri/src/agent.rs`) hard-codes tool definitions, system prompt, and approval inside `execute_tool`. This is the "one role, no seam" shape dsh explicitly rejects. Concrete ports, in priority order:

1. **Service registry keyed by capability string, with dependency-gated activation** — replace the fixed struct with a map `key → Box<dyn Service>` where `Service` has `dependencies() -> &[&str]` and activation waits until deps exist (Cordis's `inject` semantics). Keep keys stable (`shell`, `fs`, `model`, `approval`, `sandbox`) so providers are swappable rows, not struct fields.
2. **Three-role seam discipline** — for each capability define: a trait *definition* (`ShellExecutor`, `FsProvider`, `ModelAdapter` in `src-tauri/src/`), provider crates/modules (`local`, future `ssh`/`cloud-sandbox` for Phase 6), and consumers (tools). The existing `LocalRuntimePlugin` should become the *provider* of `fs`/`subprocess`/`shell` seams, not a direct registry member. Design seams now (fs/subprocess/sandbox sharing one execution world) so the Phase 6 cloud sandbox is a provider swap, exactly as dsh does with `*-ssh` packages.
3. **Effect-based registration with disposers** — every registration (tool schemas, prompt sections, event listeners, spawned processes) returns a cleanup handle; unload drops in reverse order. In Rust this maps to a `Vec<Box<dyn FnOnce()>>` owned per-plugin; `process_manager.rs` supervision should register as effects so teardown is automatic.
4. **Around-middleware event dispatch instead of hard-coded steps** — `agent.rs::execute_tool` should become: `emit("tool/pre-execute") → execute → emit("tool/post-execute")` with a `next()`-style closure chain (`Vec<Box<dyn Fn(...) -> ...>>` composed around a core executor). This is where approval, path security (`path_security.rs`), read ceilings, and content boundary belong as *policy listeners*, not inline checks. Short-circuit (return without next) = policy owns the decision — mirrors `agent/pre-step` rejection.
5. **Config-as-data composition** — replace hard-coded `tool_definitions()` / `system_prompt()` with a declarative row list (YAML/JSON in the app dir): `{id, plugin, disabled?, config}` plus ordered patches targeting rows by id (whole-config replace, last-write-wins). Port `applyEntryPatches` as a pure function (single implementation shared by app boot, config editor, and any dump command). Declarative rows make the Phase 4 plugin runtime, settings UI, and future MCP config all read the same data.
6. **Durable event log as source of truth** — dsh's invariant "model-visible means logged" is the strongest single idea to adopt: every request/tool call/observation becomes an append-only JSONL event (Entry already persists task state via `PersistedTask`); derive the model's message history from the log, and emit live UI updates (`app.emit`) as a *projection* of the same stream, so UI, recovery, and resume can't diverge. Add a formal `SessionEventMap`-style enum in Rust with per-event docs.
7. **Typed event vocab via declaration merging → Rust trait/trait-objects or a single `Event` enum** with an explicit dispatch mode per event (observe / waterfall / serial / bail) documented as contract.
8. **Approval fails closed** — `approval.rs`'s pattern list should become an `approval` seam with listener-based answerers (UI dialog, policy auto-deny) and *absence = unavailable = deny*, matching dsh.
9. **Credentials as references** — config stores references, a credentials provider resolves per call (never in config or UI state); relevant to device-flow sessions in `device_auth.rs`/`backend.rs`.
10. **Defer, but reserve**: profile/overlay multi-layer composition, HMR, and the plugin-manager install flow are dsh's heaviest machinery; for Phase 4 a single patch file + restart is enough, provided rows are addressed by stable id from day one (cheap now, impossible to retrofit).

**Suggested seam set for Phase 4** (mirroring dsh's catalog): `model` (adapters; already implicit in `ModelProviderPlugin`), `fs`, `subprocess`, `shell`, `sandbox`, `approval`, `tools` (registry + pipeline), `events`/`sessions` (log), `config` (editor). Everything-is-a-plugin then means: the agent loop itself is a plugin row that `inject`s these keys, replaceable in config — as dsh does with `ctx.agentLoop` consumed only by bundle rows (`packages/bundle/base`, `sdk-minimal`).

## Key file evidence
- Framework: `vendor/cordis/src/{context,fiber,events,service}.ts`, `vendor/include/src/index.ts`, `vendor/loader/src/config/entry.ts`
- Composition: `packages/bundle/base/cordis.patch.yml`, `packages/boot/app-boot/src/profile.ts`, `profile-plugins.ts`, `profile-resolution/`
- Seams: `packages/shell/{shell,bash-local,bash-sandbox}/`, `packages/core/tools/src/index.ts`, `packages/core/agent-loop/`, `packages/session/session-persistence/`
- Docs: `docs/cordis-primer.md`, `docs/capability-seams.md` (generated catalog), `docs/glossary.md`, `docs/architecture.md`
