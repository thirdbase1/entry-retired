# dsh Deep-Dive — Areas the Prior Briefs Missed

Companion to README/plugin-architecture/execution-layer/session-persistence/desktop-host-client.
All paths relative to `~/dsh-study`. Focus: approval end-to-end, long-running survival,
host access boundaries, MCP internals, web/client UI mechanics — with a dependency-ordered
port plan for Entry Desktop (Tauri 2 / Rust).

---

## 1. Approval / permission system, end to end

### 1.1 The approval seam (`packages/interaction/user-approval/src/index.ts`)

- **Outcome vocabulary** (`src/types.ts`): `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`. Only `allowed-once` grants, and it grants *exactly one action* — no "always allow" exists anywhere in dsh. Every other outcome, including `unavailable` (no answerer / answerer threw / answerer returned a rogue value), fails closed. This is enforced inside the service, not by callers.
- **Wire shape** — `ApprovalRequestEvent`: `{ agent, toolName, callId?, reason?, displayReason?: {en, [locale]}, signal? }`. Key design: the request **deliberately omits tool arguments**. The UI attaches the prompt to the already-streamed tool call via `callId` and renders the args from the conversation record — one copy of args, no drift between prompt and transcript.
- **Audit pair**: every `request()` appends `approval/asked {id, toolName, callId?, reason?}` to the session log, dispatches, then appends `approval/decided {id, outcome}`. Both are **log-only** (audit, never model transcript, no `surfaceOp`). `hasOpenTurn()` (index.ts) *throws* if no turn is open — the audit pair must be turn-enclosed because a bare event between turns is indistinguishable from crash-tail garbage on replay. Entry must adopt this rule: approval prompts are only possible mid-turn.
- **Per-session policy** `ApprovalPolicy = 'ask' | 'never'` (that's the whole vocabulary — there is no "always-allow", no per-tool allowlist). Stored as a durable `approval/policy` event; last event wins. `never` is enforced **inside the service before any waterfall dispatch**, so a `prepend: true` listener cannot bypass it. Policy switches inject a `user-approval`-sourced user message ("policy changed from X to Y") so the model learns deterministically; the system prompt carries the current policy sentence via a `systemPrompt.context()` block that travels *after* retained history (cache-prefix stability).

### 1.2 Dispatch: waterfall over Remote Events

Host side: `ctx.approval.request()` → `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, () => 'unavailable')` — scoped so agent-scoped listeners only answer their own agents; raced against `req.signal` (abort → `cancelled`, late answers discarded).

Client side (`packages/client/ui-approval/src/client/index.ts`): the browser registers `ctx.remote.$on('approval/request', ...)` — the same waterfall carried over the API Gateway's `$events` logical stream into the Session-scoped client Context. `answerApproval()`:
1. resolves the owning sessionId; no session scope → `next()` (delegates onward → eventually `unavailable`);
2. creates a `PendingApproval` and registers it as a **pending interaction** on `ctx.uiSession` (a per-session queue of "something needs a human");
3. awaits the user's answer; a special delegation error → `next()`; finally removes the pending interaction.

### 1.3 UI wiring (`ApprovalPanel.tsx`, `contract/slots.ts`)

- The approval prompt is a **composer takeover**, not a modal: `ui-approval` registers a slot at `'conversation.composer'` (priority 1) whose selector picks the pending interaction when it's a `PendingApproval`. The composer area is replaced by the approval card while pending — the user can't keep typing a new prompt past an unanswered gate.
- Card shows: warning dot + "waiting" strip, headline = `displayReason` (localized, resolved via `locale.resolveText`) or the audit `reason`, then a detail slot `'conversation.approval.detail'` keyed by `callId` — the bash/fs packages own renderers there that reproduce the *exact* command from the tool call record.
- Keyboard: Enter = allow, Escape = reject, with careful IME guards (`isComposing`, keyCode 229, composition start/end capture) and a rule that Enter inside a focused button/link doesn't double-fire. Allow/reject are one-shot: `waiting.current` + `answered` state; a failed `answer()` resets.
- Shortcuts `approval.allow`/`approval.reject` are registered as fixed shortcuts so they appear in the shortcut reference UI.

### 1.4 Tool-gated approval: the `tools/pre-execute` waterfall

`packages/core/tools/src/index.ts`: the registry dispatches `tools/pre-execute` as a waterfall with `PreToolDecision = allow | deny{reason,info} | cancel | ask{reason,displayReason}`. `ask` is resolved *by the registry* through `ctx.approval.request()` — runs only if `allowed-once`, otherwise materializes a denial. Two detail rules worth porting:
- Listener ordering can never turn a denial back into permission (the registry normalizes after the chain).
- Caller-cancellation re-checks happen after async gates settle; the registry never abandons a gate's promise, it just overrides a *successful* outcome if the caller aborted meanwhile.

### 1.5 Sandbox escalation (the actual "dangerous action" flow)

`packages/sandbox/sandbox/src/escalation.ts` is the single home for the model-initiated escalation:

- Tool schema advertises `sandbox_permissions` (enum pinned to the **closed** `ESCALATION_TARGETS = ['workspace-write','danger-full-access']`) plus a required `justification` ("one sentence for the user"). The enum is deliberately *not* narrowed to the current session's mode — schemas are registry-global, the effective mode is per-call truth.
- `WIDER_MODES` table: read-only → {workspace-write, danger-full-access}; workspace-write → {danger-full-access}. Escalation is strictly-widening only; requesting the current effective mode is a no-op; narrower/unsupported → throw before execution.
- `approveEscalation()` fails closed if no approval service or no agent, then asks with `reason: "escalate sandbox to <mode>: <justification>"` and bilingual `displayReason`. On grant, **the wider mode applies to that one call only** — `SandboxPolicy` is carried per call (`packages/sandbox/sandbox/src/index.ts` doc block: "two consumers may confine under different policies at the same instant").
- Model-facing denial rendering (`packages/shell/tool-bash/src/render.ts`): a sandbox denial appends `[sandbox: file access denied under <mode> mode]` + an escalation hint marker when escalation is available. Non-zero exits are *reported, not errored* — only infrastructure failures become isError.

### 1.6 Permission presets — the knob bundler

`packages/interaction/permission-presets/src/index.ts` + `docs/subsystems/permission-presets.md`: bundles sandbox mode + approval policy into named presets (default table: `workspace-write` = workspace-write+ask, `danger-full-access` = danger-full-access+never). `custom`/`auto` are reserved. Switching appends a log-only `permission/preset` event then writes each knob event **only when that knob actually changes**; the `permissions` *session projection* folds the three knob events into `PermissionSelection { currentValue }` for the client. Client joins the projection with a process-level `PermissionCatalog` (Remote), refreshed on the payload-free `permission-presets/catalog-changed` event. `auto` is a current-session-only option published by the Auto-review integration through a fixed `registerAuto(admit)` hook — not a generic contribution API.

---

## 2. Long-running agents: jobs, subagents, reminders, ownership, retention

### 2.1 Jobs (`packages/jobs/jobs/src/types.ts`, `jobs-local/src/index.ts`, `docs/subsystems/jobs.md`)

- **Identity**: `JobId` = `<kind>-N` (kinds `bash`, `subagent` via merge-extensible `JobKindMap`). Ids are predictable; **authorization, not id secrecy, is the boundary** — every registry call takes the caller's `SessionId`, and owned jobs are fenced to the owner (plus unowned jobs visible to all).
- **Owner lifecycle**: the `owner` SessionId resolves to the live Agent; **its disposal cancels and awaits the job** (`disposeOwned`, jobs-local/index.ts:611-640). Service teardown cancels everything (`cancelForTeardown`); a throwing teardown `cancel` force-fails only the *record* and logs "work may be orphaned" — it never claims the work stopped.
- **Producer contract**: `JobSpec { kind, label, owner?, outputLimitBytes?, output?: JobOutputSource[], run(JobHandle) → JobHooks }`. `JobHooks = { cancel(reason?), done: Promise<JobOutcome> }`. `done` resolves after the producer releases resources, not merely when work ends. Preflight (access + cleanup) happens before `run()`; after `run()` returns, **registration cannot fail** — no failable step post-commit. `JobOutcome { status: completed|killed|failed, detail?, result? }` — `result` is the value-returning job's answer (e.g. a subagent report), handed out exactly once on the first `read` after settlement.
- **Output ring** (`jobs-local/src/ring.ts`): bounded byte ring at *absolute* UTF-8 offsets; head eviction never moves assigned offsets; oversized chunks are tail-sampled at a code-point boundary. Reads from any offset are non-consuming (`readAt`); the *model* has a consuming cursor (`read`). Live retention default 256 KiB (`retainBytes`), settled retention 16 KiB. Readers below the window get a `lossy: true` read — never an error. `spillPaths` in the projection names where evicted bytes live (`packages/spill/spill-local`: root `dsh-spill-<6char>`, startup cleanup matches the exact shape).
- **Events**: one filtered stream; `output` events carry only `{id, owner?, total}` — observers re-read from their own cursor, the registry never pushes payloads. `settled` carries `awaited: bool` so a completion reporter skips settlements a live `wait()` already collected.
- **What does NOT survive a crash**: the registry is a local, in-process service. Jobs are not durable records; after a Host restart, live work is gone and only the session log's tool-jobs notices/recall events (`docs/persistence-catalog.md` `tool-jobs` forms: catalog/instructions/notice/recall/relay/snapshot) tell the model what was running. Crash recovery of *sessions* is the `interruptedTurnClosers` path (prior brief covered); recovery of *jobs* is simply "notify the model, don't resurrect."
- `start` refuses while no job controller serves the spec's owner — a producer can't start work its owner can't collect or stop.

### 2.2 Subagents (`docs/subsystems/subagent.md`, `packages/subagent/*`)

- **Registry, not single service**: `ctx.subagents` holds multiple named providers (spawn-in-process, fork-in-process, ACP, Codex, Claude Code, DSH SDK). Start-time capability flags (`agentOptions, outputSchema, depthLimit, toolFilter, persona`) are checked **before** start — unsupported = typed `SubagentError('UNSUPPORTED_CAPABILITY')`, never accepted-then-ignored. Continuable children are gated by *method presence* (`prepareContinuable`) instead of a flag.
- **Catalog**: `subagentCatalog` session projection exposes children in parent event order (id, created, mode, label); historical children with unknown descriptors get `mode: 'unknown'` — header identity survives, continuation doesn't.
- Cancellation is one canonical channel: the tool's `exec.signal` works both pre-publication (reject + clean partial resources) and post-publication (cancel remaining turn work).
- `tool-subagent-control` adds the optional cross-agent controls (`send_message`, `interrupt_agent`, `list_agents`).

### 2.3 Reminders / schedule (`docs/subsystems/schedule.md`, `packages/schedule/schedule`)

- Fully durable, session-bound: a `ScheduleRecord` (one-shot `after`/`at`; recurring `every`/`daily`/`weekly`/`cron`) is stored in the `schedule` storage domain **with its original sessionId**, plus `status` and `lastDelivery`. Delivered to the original session even though sessions are activated lazily.
- Hard invariants worth copying: required `title` (trimmed, ≤120 chars) — one bad record **rejects the whole domain open** (no backup-and-skip); creation canonicalizes to RFC 3339 UTC `scheduledAt` so replay never re-resolves timezone rules; explicit IANA zone stored verbatim for daily/weekly/cron.
- Catch-up policy: on restart with overdue recurring records, **only the latest due occurrence fires**; misses never accumulate. Fixed-rate `every` ≥ 60s, measures elapsed time (not wall-clock), aligned to creation anchor. DST gaps skip; overlaps pick the earlier instant.
- Delivery history retention: per-task records capped (default 200, `deliveryHistoryRecords`) and windowed (`deliveryHistoryDays`); a delivery **commits only when `ctx.sessions.flush()` confirms** the follow-up landed (index.ts:96).
- Experimental `time-context` bundle samples the browser's IANA zone per prompt to disambiguate natural-language dates — never durable; the model must still pass an offset or `time_zone`.

---

## 3. Access to the user's laptop: sandbox, filesystem, network

### 3.1 Sandbox (`docs/subsystems/sandbox.md`, `packages/sandbox/sandbox-local`)

- `SandboxMode = read-only | workspace-write | danger-full-access` — **file effects only**; network and process visibility are explicitly outside this vocabulary. `danger-full-access` never calls `ctx.sandbox` (spawn original argv).
- Enforcement is a *reported fact*: `ConfinedArgv { argv, enforcement: 'full'|'partial', denialSignatures, runnerFailureRules }`. Partial enforcement (old Landlock ABIs, Windows ACL hard-link/read gaps) must be surfaced, never treated as full.
- Runner chains (sandbox-local/src/index.ts): Linux bwrap→Landlock (functional probe of competing candidates), macOS Seatbelt, Windows ACL restricted-token. Windows: write-SID is per-workspace (canonical-path-derived, ACE materializes once and *stands* — O(1) later provisions); each live session gets a RANDOM private temp dir + capability SID, revoked on dispose. Missing confinement **fails closed**, never returns the original argv.
- Two orthogonal stderr classifiers on every confined run: `denialSignatures` (the command was blocked — sandbox working) vs `runnerFailureRules` (the runner itself failed before executing — infrastructure failure, checked *first*, exit-code-gated, informational full-line exclusions removed before matching). Consumers must not show "sandbox broke" as an ordinary task failure.
- The workspace root derives from the calling session's **immutable cwd**; providers canonicalize it (`symlink/..` resolves to where the paired subprocess actually runs).

### 3.2 Filesystem (`docs/subsystems/filesystem.md`)

- `ctx.fs` resolves every user path to an **opaque `FsTarget { targetKey, displayPath }`** — consumers may never parse `targetKey` or assume an absolute path. Cross-capability identity goes through the provider (`processPath()`, `processPathFromHostPath()`, `contains()`), so remote/SSH backends drop in without changing tool schemas.
- Write/edit freshness via backend-owned **file-version tokens** enforced by the optional `fs-observation-policy` plugin (read-before-write default); remove the plugin and write is unconditional — the tool itself is policy-free (calls `ctx.fs` + events, never policy methods).

### 3.3 Network policy & client trust

- There is **no network sandbox policy** in the sandbox seam — network is governed only by process-level confinement (bwrap/Seatbelt can restrict it, but the vocabulary doesn't express it). Entry should consider making network an explicit policy axis.
- The browser↔Host boundary has a real fence: `packages/client/connection/src/api-request-trust.ts` defends the two confused-deputy paths of a local HTTP API — DNS rebinding and cross-origin requests from a malicious page. Every `/api` request is bound to a trust header Host verifies; unmarked requests are rejected even though Host *is* the header rebinding can't forge (defense in depth); `trustedHosts` bare-authority entries extend it for LAN clients. **Tauri equivalent matters**: with Tauri's custom-protocol + capability model this is largely free, but any localhost HTTP/WS sidecar must reproduce this fence.

### 3.4 What runs where

Everything privileged (sandbox wrapping, job registry, schedule, MCP server processes, session logs, spill files, credential handling) runs in the Host (Node). The browser client is pure projection — it holds zero authority: every mutation goes through generated Remote methods, every answer through scoped waterfalls. `packages/sandbox/sandbox-ssh` + SSH fs/subprocess providers extend the *same* seams to a remote backend, which is the existence proof that host access is seam-pluggable.

---

## 4. MCP integration internals

`packages/mcp/mcp-client/src/{index,connection,transport,tools,server-context}.ts` (~1.2k lines):

- **Namespacing**: tools register on `ctx.tools` as `mcp__<serverName>__<rawName>`; `serverName` must match `[A-Za-z0-9_-]{1,32}` and is reserved per registration scope (WeakMap of Sets — a global name is exclusive, but two Agent scopes may each host the same server name). Plugin disposal unregisters tools and releases the reservation; HMR reload with the same name reproduces identical public names.
- **Connection supervisor** (`connection.ts`): one plugin instance = one server = one supervised *generation* chain. A generation = fresh `Client` + transport (SDK binds a Protocol to one transport for life, so reconnect always builds a new generation). `isCurrent(generation)` guards every callback so stale generations are inert.
- **Reconnect policy**: `{enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10}` — exponential doubling, and a **stability window resets the budget**: a connection up ≥ `maxDelayMs` closes the outage, so a crash-looping server that briefly connects still exhausts the cap instead of restarting forever. On exhaustion: tools unregistered, reconnect stops; *only disposal/reload restores*. Unconfirmed transport closure during teardown also stops reconnect (never risk overlapping server processes). All config re-validated at load with the exact error path (`path.initialDelayMs …`) — programmatic construction can't skip validation.
- **Tool sync serialization**: a `syncChain` promise serializes every `syncTools` (initial + notification-driven re-syncs) across generations so the dispose-previous/register-next swap can never interleave. `failOnStartupError` promotes the *initial* sync to `registrationFailure: 'throw'`; later syncs contain conflicts.
- **Server instructions**: nonblank `getInstructions()` published as a scoped system-prompt section `### MCP server: <name>` under `maxInstructionBytes` (default 32768, exceeding = connection error); republished only after discovery succeeds.
- **Config** (index.ts): stdio `{command, args, env (merged over scrubbed ambient env — credential-shaped and stale `DSH_*` names dropped), cwd}` or streamable-http `{url, headers}`; `toolCallTimeoutMs` default 60s; resources requests ride `exec.signal` + the same timeout.
- **Resources** (`mcp-resources`): shared `ctx.mcpResources.register(server, provider)` — the shared tools (`resources/list/read`) appear when the caller's scope has ≥1 provider and disappear with the last; connection failures don't remove the shared tools. Unsupported product-wide: prompts, elicitation, tasks, resource subscriptions.
- **Result adaptation** (`tools.ts`): canonical MCP JSON retained for programmatic callers; images → attachment system; unsupported rich content → explicit text diagnostics; the harness tool registry stays authoritative for permission failures.

---

## 5. UI mechanics in packages/web + packages/client beyond tokens

### 5.1 Durable-vs-transient streaming (`packages/api/session-controller/src/client/sessions/assistant-stream.ts`)

The heart of "reconnect and paged history reproduce the same assistant state":
- LLM attempts publish **compact records** (`packages/llm/llm/src/assistant-stream.ts`): `AssistantStreamAccumulator` packs `text-delta`/`reasoning-delta`/`tool-call-delta` into lossless `{type:'text-chunks'|'reasoning-chunks', time0, index, dt[], texts[]}` / `{type:'tool-call-chunks', time0, index, id, name?, args[]}` runs — every chunk's *timestamp offset* preserved (so UI can show first-token latency, streaming pace) at a fraction of the bytes. These records are embedded **in durable session events**; `expandAssistantStream()` is the validating replay path at durable boundaries.
- `ClientAssistantStream` folds transient live frames + durable settlements: publishes `assistant/live-chunk` entries, retires a successful attempt's transient rows when its step-end settles, buffers pending settlements, and on `replace()` (reconnect/page) reconstructs transient chunks from the durable baseline. Result kinds: `publish | settlement | abandonment | transient | rebaseline`.
- Consequence for Entry: **no durable raw token rows**. Persist compact records at step boundaries; the client renders streaming from transient frames and rebuilds identical UI from records alone.

### 5.2 Conversation node structure (`packages/client/ui-chat`)

- Pipeline: `ui-conversation` binds to the session event source → an **event registry** correlates durable events + live chunks into business Contexts → target packages (`ui-chat`, `ui-trajectory`) register separate *Definitions* whose builders produce final `ChatNode {kind, data, anchorSeq, location, visibility}` units → registered node renderers. Two targets may read the same events but never share display models.
- Node kinds (`contract/chat-nodes.ts`): `assistant-step {status: running|settled|interrupted, blocks, time, usage?}`, `tool-call {root: ToolCallBlock}` (root lifecycle owns recursively nested subcalls, `MAX_DEPTH 256`, per-block interruption seq/time), plus command, compaction (command+transaction correlated), retry (whole chain rendered as one row), turn-process, turn-tail, inbox, turn-error, turn-max-tokens, fallback.
- **Turn folding** (`conversation-nodes/README.md` — 3-level visibility): whole Turn → process group → individual reasoning/tool disclosure; "opening an inner layer cannot bypass a closed outer layer". Display modes Compact/Standard/Detailed/Verbose decide whether *running* bodies show; manual disclosure choices survive mode changes. A turn = groups of consecutive same-category work (reasoning + read = one group; read→bash switches group); intermediate replies separate groups but still fold away; only the final answer is protected from whole-turn folding. Steering messages and non-human trigger notices are "opening inputs" that pin the turn open — a subtle but load-bearing rule.
- Reasoning inside a group is hidden at the group level when the turn-process control collapses it (`AssistantNodeView.tsx: reasoningHidden = turnProcess !== undefined`).

### 5.3 Composer

- **Lexical editor** (0.49) with a projection/span-map layer (`ui-conversation/src/client/input/editor/`): reference chips (`@file` style), claim decoration for slash commands, decorator portals. Draft state lives in the editor; the input *machine* owns only submit plane: phase/claim/attempt (`contract/input.ts`).
- **Submission semantics** (`composer-submission.ts`, `submission-settings.ts`): `MessageSubmission {timestamp, source: 'click'|'enter', mode, state}` where `mode` = `BusyEnterBehavior = 'queue' | 'steer'` — the meaning of Enter while the agent is busy is a *durable per-session setting*, default `queue`. Commands claim the composer via `CommandClaim {name, token, hint?, attachments?, submit(args, actx, attachments)}` — full arbitration machinery (`ArbitrateKey/Outcome`) for typing `/` mid-text. Attachments: inline images (base64) or `file` receipts (uploaded via file-upload first, referenced by id).
- Same composer hosts approval takeover (§1.3) and the pending-question takeover — one slot chain, priority-ordered.

### 5.4 Jobs UI (`packages/client/ui-jobs/src/client/JobListAction.tsx`)

Session-header action + popover fed by a client-side `ClientJobs` snapshot (from `job.list`/`job.follow` Remotes). Reference-counted `watchRows(sessionId)` and `observe(sessionId, jobId)` (panel output), `killJob()` resolves "admitted" (`requested`/`already-finished`) and the row converges via control frames — **the kill button never mutates local state directly**. Terminal block renders ring output from the observer cursor.

### 5.5 Boot / client model layer (summary, details in prior brief)

Host writes a `WebBootGraph` to `window.__DSH_BOOT__`; client model layer (`ClientSessions → SessionManager → Session`) holds React-free identity-stable mirrors; `ui-renderer` is the only `useSyncExternalStore` binding point. Recovery rule: physical gateway reconnect ≠ logical recovery — each logical stream reopens on a new generation, validates sequence ranges, and replaces its window from the generation's opening snapshot; `page()` repairs gaps.

---

## 6. Port to Entry — what to build in Rust/Tauri vs React, ordered by dependency

Order matters: approval needs events; jobs need the log; UI needs the client model. Tiers build on prior tiers.

### Tier 0 — Rust core primitives (no UI)
1. **Session event log + `interruptedTurnClosers` repair** (covered by prior brief; prerequisite for everything below — approval audit pairs and stream records live in it).
2. **Approval types** (Rust enums/structs): `ApprovalOutcome`, `ApprovalRequest {tool_name, call_id, reason, display_reason: BTreeMap<Locale,String>}`, audit pair `approval/asked`/`approval/decided`, `ApprovalPolicy {Ask, Never}` with the **in-service, pre-dispatch `never` gate** and the fail-closed default (`unavailable` on no answerer / panic / malformed answer). Adopt: request() must reject when no turn is open.
3. **Tool pipeline pre-execute gate** with `PreToolDecision {Allow, Deny{reason}, Cancel, Ask}` — registry resolves `Ask` through the approval service; listener order can never flip a denial.

### Tier 1 — Sandbox + escalation (Rust)
4. **Per-call `SandboxPolicy {mode, workspace_root, session_id}`** resolved once at the consumer boundary; provider never holds policy state.
5. **Sandbox backends**: Linux bwrap/Landlock, macOS Seatbelt — with `enforcement: full|partial` reporting, `denialSignatures` vs `runnerFailureRules` classification (runner failure checked first, fails closed). Windows ACL can come later; start partial-honest.
6. **Escalation module**: `WIDER_MODES` table, `sandbox_permissions` + required `justification`, per-call grant only, model-facing denial marker + escalation hint. Schema enum = closed target vocabulary, not the current mode.

### Tier 2 — Approval transport + UI (React)
7. **Scoped event waterfall over Tauri IPC**: port the `approval/request` waterfall shape — listeners return an outcome or delegate; session-scoped routing; abort-signal racing. In Tauri, Host-side listeners + the webview answerer both implement the same trait; the webview registers via a `remote.$on`-style channel.
8. **Pending-interaction queue + composer takeover**: one per-session queue of answerable prompts; approval renders as a composer replacement card (Enter=allow/Esc=reject with IME guards), attaching tool-call detail by `callId` from the conversation record. Permission presets selector: bundle `{sandbox_mode, approval_policy}` per preset; durable `permission/preset` + knob events; client joins a `permissions` projection with a process catalog (refreshed on a catalog-changed notification).

### Tier 3 — Jobs runtime (Rust) + panels (React)
9. **JobRegistry**: `<kind>-N` ids, owner-session fencing on every call, preflight-before-run / no-fail-after-commit, `JobOutcome.result` handed out once, event stream with payload-free `output` notifications.
10. **Output ring + spill**: absolute-offset ring, head eviction, code-point-safe tail sampling, live 256 KiB / settled 16 KiB retention, `lossy` reads, spill files (0700) with path in the projection.
11. **Bash background job adaptation** (`job_output` tool, completion notice, kill-reason merge). **Jobs are process-local by design** — don't build job persistence; on restart surface a notice from the log instead.
12. React: jobs popover (watch/observe refcounting, kill → "admitted" then converge from frames).

### Tier 4 — Schedule (Rust, durable)
13. Schedule storage domain bound to sessionId; `title` strictness (bad record rejects domain open — port this); canonical UTC `scheduledAt`; latest-occurrence-only catch-up; `every` ≥ 60s; DST gap/overlap rules; delivery-history retention; delivery commits only after session flush.

### Tier 5 — Streaming + conversation UI (React + Rust records)
14. **AssistantStreamAccumulator port (Rust)** producing compact records with per-chunk time offsets, embedded in durable step events; validating `expand` at replay boundaries.
15. Client stream fold (TypeScript): transient `live-chunk` entries + settlement retirement + baseline rebuild on reconnect/page — no durable raw token rows.
16. Conversation node pipeline: event registry → chat definition/builder → node renderers with the 3-level fold (turn → group → disclosure), category-based grouping, tool-call tree (nested subcalls, interruption markers), retry-chain rows, compaction correlation.
17. Composer: submission machine (`queue|steer` busy-Enter setting), slash-command claim/arbitration, reference chips, attachment receipts; approval/question takeovers ride the same slot chain.

### Tier 6 — MCP (Rust)
18. MCP client supervisor: generation-per-reconnect, isCurrent guards, exponential backoff with stability-window budget reset, give-up = unregister tools until reload, serialized tool-sync chain, `mcp__<server>__<tool>` namespacing with per-scope name reservation, instructions section with byte cap. Use `rmcp`/official Rust SDK; keep the config surface (`stdio{command,args,env,cwd}` / `streamable-http{url,headers}`, 60s call timeout) identical.
19. MCP resources as a shared provider registry (tools appear with ≥1 provider in scope).

### Tier 7 — Client hardening
20. Trust fence: for any local HTTP/WS sidecar reproduce the Host-verified trust header (DNS-rebinding + confused-deputy defense); with pure Tauri custom-protocol, document why it's unnecessary.
21. Remote/stream recovery semantics: every logical stream opens with a complete baseline snapshot, validates sequence ranges, replaces its window per generation; `page()` only for history/gap repair.

**Consciously skip** (dsh doesn't have them either): "always allow" approvals, per-tool allowlists, durable job records, network-policy in the sandbox vocabulary, MCP prompts/elicitation/tasks/subscriptions.

**Rust vs React split, one line each**: Rust owns every authority — log, approval gate, sandbox, jobs, schedule, MCP, stream records. React owns zero authority — pending-interaction queue, composer, fold state, node renderers, and answers flow back through scoped waterfalls only.
