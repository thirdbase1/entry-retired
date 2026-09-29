# Interface & UX Patterns of Open-Source AI Coding Desktops (2025/2026)

Research summary for Entry Desktop (Tauri 2, React, Rust, Geist/Vercel-style dark UI).
Sources verified via live web search/extract, Sep 2026.

---

## 1. OpenCode (sst/opencode) — TUI-first, now a desktop beta

- **Layout:** Terminal UI (Go TUI, Bubble-Tea-like): a single scrollable conversation column with a composer at the bottom; header shows session/model; sessions are first-class objects (`/sessions` list-and-switch). A separate desktop app (BETA, download at opencode.ai/download) wraps the same client/server core — the server exposes sessions/messages/tool calls over HTTP, which is exactly why multiple community GUIs exist (opencode-viewer, opencode-gui). https://opencode.ai/docs/tui/ ; https://github.com/skorokithakis/opencode
- **Agent run / tool visualization:** Tool calls render inline as compact blocks; `/details` toggles tool-execution detail visibility; `/thinking` toggles reasoning blocks. Message-level undo/redo is Git-backed (`/undo`, `/redo` require a Git repo). https://opencode.ai/docs/tui/
- **Approval UX:** Largely config/permission-mode driven rather than per-action dialogs in the TUI; the TUI favors non-blocking flow.
- **Model selector:** `/models` (Ctrl+X m) with provider picker via `/connect`; models are plain strings `provider/model` in config. https://opencode.ai/docs/tui/
- **Neat techniques:** `@` fuzzy file mention in composer; `!` prefix to run shell and inject output as tool result; heavy keyboard-leader scheme (`ctrl+x`); themes (`/themes`); shareable session URLs (`/share`). Copy: **tool details behind a global toggle, not per-card chrome.**

## 2. DeepSeek desktop / artifacts UI

- No official desktop app from DeepSeek itself; the ecosystem ships **Tauri 2 clients** that embed the official WebUI/Harness: DSH-Desktop (Tauri 2 + React 19, hosts the official WebUI, auto-manages a local engine, Win/macOS/Linux) and deepseek-desktop (Chat + Harness modes, manual toggle). https://github.com/dongdong-agent/DSH-Desktop ; https://github.com/zcx960/deepseek-desktop
- **Pattern worth copying:** "embed the web app, wrap native shell around it" — session chrome (window, tray, engine lifecycle, updates) is native; content is the proven web UI. Artifacts-style rendering stays in the embedded webview.

## 3. Zed — Agent Panel in a native editor

- **Layout:** Right-docked **Agent Panel** with a thread (chat history) + message editor at bottom; **Threads Sidebar** for past threads; agent can also run headless. Context is added via `@` (files, directories, symbols, previous threads, skills, diagnostics, branch diffs, URLs). https://zed.dev/docs/ai/agent-panel
- **Tool visualization:** Tool calls appear as collapsible cards in the thread; edits surface as diffs in the editor's gutter/multibuffer; thumbs up/down per response (with a follow-up textarea on 👎) feeding prompt improvement. https://zed.dev/docs/ai/agent-panel
- **Approval UX — best in class, copy this:** `agent.tool_permissions` with three verbs (`allow` / `confirm` / `deny`) and **regex patterns per tool** (`always_allow`, `always_deny`, `always_confirm`), matched against the actual input (shell command string, file path, URL). Chained commands are parsed and each sub-command checked; built-in security rules catch `rm -rf` variants. The permission dialog offers: **Allow once / Deny once / Always for \<tool\> / Always for \<pattern\>** — the "extract a safe pattern from this input" trick is the standout. https://zed.dev/docs/ai/tool-permissions
- **Model/profile UX:** Agent Profiles bundle a default model + toolset per profile. https://zed.dev/docs/ai/agent-profiles

## 4. ZCode (Z.ai) — exists; agent-first "ADE", no code editor

- **Layout:** Desktop app (macOS/Win/Linux): file manager, terminal, Git panel, browser preview, and agent chat in one window — but **no traditional code editor**; you review, the agent writes. https://flaviocopes.com/zcode/ ; https://bitdoze.com/zcode-ai-review
- **Run visualization:** "Goal Mode" for long tasks; parallel tasks/Goals/automations. Conversation-level rollback: **every message creates a checkpoint**; multi-file diff view per interaction; undo last interaction or jump to state after any message. https://bitdoze.com/zcode-ai-review
- **Approval/noted gap:** an interesting pattern — **answer blocking questions from your phone** (Bot Channel): when a long task pauses on one question, you answer remotely instead of finding the task stuck. https://flaviocopes.com/zcode/
- **Context composer:** attachments (screenshots/docs), `@` files, `#` link past conversations as context, `/` saved prompts. `AGENTS.md` (auto-ported from `CLAUDE.md`). Plugin types: Agent/Command/MCP/LSP/Skill/Hook.

## 5. Warp — terminal that became an ADE

- **Layout:** Two explicit modes: **Terminal mode** (clean, block-based output) and **Agent conversation view** (rich controls: model select, voice, image attachments). Four pillars: Code (built-in editor with agent diff review), Agents, Terminal, Drive (team knowledge). https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/agent-modality ; https://dev.to/jangwook_kim_e31e7291ad98/warp-20-the-terminal-that-became-an-agentic-development-environment-48j5
- **Run visualization:** Agents stream into the same block-based terminal; a management UI shows status of all running agents with notifications on completion or when input is needed. Pair mode (interactive) vs Dispatch mode (autonomous, notify when done). https://dev.to/...warp-20...
- **Approval UX:** In-agent diff review panel; users accept/reject proposed file changes without leaving the app (company claims 96%+ diff acceptance). https://dev.to/...warp-20...
- **Model selector:** curated model list + "auto-select best model" option; `/model` slash command in conversations; per-response cost/credit display in CLI. https://docs.warp.dev/agent-platform/inference/model-choice
- **Neat techniques:** slash-command palette incl. `/fork-and-compact`, `/fork from` (fork conversation at a chosen past point); "charms" (cwd, git branch, diff entry point) as inline status chips; up-arrow inline history menu; blocks-as-context (attach any prior terminal block to a prompt).

## 6. Goose (Block) — Rust agent, desktop + CLI

- **Layout:** Desktop app (Egui/TS hybrid historically) with chat canvas; CLI for power users; **MCP Apps let extensions render interactive UIs (buttons, forms, visualizations) inside the chat**. Subagents for parallel work. https://andrew.ooo/posts/goose-review-open-source-ai-agent-block ; https://block.github.io/goose/blog/2026/02/23/goose-v1-25-0
- **Approval UX:** explicit **Permission Modes** (ask-before / auto-approve / disable-all tiers) set globally or per-lead; plus sandboxing (macOS Seatbelt in v1.25.0), prompt-injection detection, and an adversary reviewer. https://goose-docs.ai/docs/guides/goose-permissions/ ; v1.25.0 blog above.
- **Model UX:** provider-agnostic first-run config wizard (Anthropic/OpenAI/Ollama etc.); v1.25.0 "unified configuration" simplified provider/profile settings.
- **Neat techniques:** Recipes (YAML workflows) launchable from UI/CLI; "Berd" companion workspace app shows the local-first data direction (https://andrew.ooo/posts/berd-block-open-source-agent-desktop-review).

## 7. Cline — VS Code extension, plan/act + checkpoints

- **Layout:** Webview sidebar: single scrollable **timeline of chat steps** interleaved with tool-call cards; settings via gear. Now also ships as CLI/Kanban/SDK. https://github.com/Cline/Cline
- **Run visualization:** Each tool use renders as a card (read/edit/execute/browser) with expandable output; **Plan mode vs Act mode** is a hard toggle — Plan is read-only conversation, Act executes; context carries across the switch. https://github.com/cline/cline/blob/main/docs/core-workflows/plan-and-act.mdx
- **Approval UX:** per-tool-category **Auto-approve toggles** (read files / edit files / run commands / browser / MCP) with per-category limits; combined with **Checkpoints** — snapshot on every file/command, shown as a bookmark icon on a dotted line with **Compare / Restore** buttons; restore options: "Task only" vs "Files & Task". Checkpoints are what make auto-approve safe ("cost of a mistake drops to nearly zero"). https://docs.cline.bot/core-workflows/checkpoints
- **Neat technique:** message-editing integrates with checkpoints ("Restore All" = rewind files + edit prompt + resubmit). Copy: **checkpoints as the permission system's safety net, not just version control.**

## 8. OpenHands — event-log architecture

- **Layout:** Web UI (localhost Docker or app) with panels for files, browser screenshot, Jupyter, and chat; the agent conversation is a rendered **append-only event stream**. https://proceedings.iclr.cc/paper_files/paper/2025/file/a4b6ad6b48850c0c331d1259fc66a69c-Paper-Conference.pdf
- **Run visualization — architectural idea to copy:** the SDK defines typed immutable events: `MessageEvent`, `ActionEvent` (tool call w/ thought + security risk), `ObservationEvent`, `UserRejectObservation`, `AgentErrorEvent`, `PauseEvent`, `CondensationSummaryEvent`. UI = pure projection of this log. Rejections and errors are first-class event types. https://docs.openhands.dev/sdk/arch/events
- **Approval UX:** confirmation mode produces `UserRejectObservation` events — the rejection itself becomes part of the conversation record.

## 9. Aider — terminal, git-diff native

- **Layout/visualization:** pure CLI pair-programmer; every change lands as a **colored unified diff in the terminal, auto-committed with a descriptive message** — the diff IS the review UI; undo = `git` reverts. `/undo`, `/diff`, repo-map context. https://aider.chat/docs/ ; https://genalphai.com/aider-power-user-guide
- **Neat technique:** "every edit is a real, readable, revertible git diff — no sandbox black box." For a GUI: surface the git commit per agent turn as the timeline node.

## 10. Conductor — Mac-native parallel agent manager

- **Layout:** Dashboard of **workspaces** (one git worktree each); per-workspace chat pane + diff pane + review flow; unified status view for all agents and pending reviews; Dispatcher routes tasks to agents. Uses your existing Claude/Codex subscriptions (OAuth login to Anthropic inside the app). Native Mac (not Electron). https://rywalker.com/research/conductor ; https://continuumcode.ai/guides/what-is-conductor
- **Neat technique:** **worktree-per-agent as the primary navigation object**; review/merge as the terminal step of every agent run. (Same pattern: Crystal/Nimbalyst, stravu/crystal — Electron app running multiple Claude Code/Codex sessions in parallel worktrees with run logs, diffs, and branch management. https://github.com/stravu/crystal)

## 11. Crystal (stravu) — now Nimbalyst

- Parallel Claude Code/Codex sessions in git worktrees, one Electron desktop app: session cards with status (running/needs-approval/done), live output streaming, file diffs per session, and a sidebar of repos→sessions. The "needs-approval" badge on the card is the key state indicator to copy. https://github.com/stravu/crystal

---

## Cross-cutting: Tauri-based AI desktops & in-app OAuth

**Tauri AI desktops found:** DSH-Desktop & deepseek-desktop (DeepSeek WebUI shells, Tauri 2 + React 19), geminidesktop.app, bibigpt-desktop, aigtd, tauri-ai-starter template, Crystal (Electron — note: not Tauri), OpenCode Desktop (Tauri-based beta). https://github.com/tauri-apps/awesome-tauri

**OAuth patterns (recommendation: PKCE + custom deep-link scheme):**
1. **Custom scheme + deep link** (most common): register `myapp://` via `tauri-plugin-deep-link` (`tauri.conf.json > plugins > deep-link > schemes`); app opens system browser → provider login → `myapp://callback?code=...` → `onOpenUrl` / `deep-link://new-url` event → Rust emits `oauth-callback` to the webview → exchange code+verifier for tokens. Chosen by geminidesktop for OpenRouter PKCE (day-7 retention 38%→71% after replacing key-paste). Pros: no local server, no firewall issues. Cons: scheme must be allowlisted by the provider (OpenRouter supports it). https://v2.tauri.app/plugin/deep-linking ; https://tauri.app/plugin/deep-linking ; https://geminidesktop.app/en/blog/openrouter-oauth-pkce-tauri-desktop-2026
2. **Loopback server** (`http://127.0.0.1:<random>`): OAuth-BRFC-8252-standard, but needs a local HTTP listener (in Tauri usually spawned via sidecar/shell — flaky, and Windows Defender sometimes flags it). https://errors.standardbeagle.com/tinyhumansai/openhuman/openrouter-oauth-requires-the-desktop-app-use-an-api-key
3. **PKCE state pitfalls:** store `code_verifier` in **localStorage/webview store** (in-memory dies when backgrounded); proactively refresh short-lived tokens (OpenRouter: 1h access / 30d refresh) via a fetch interceptor; only show a re-auth modal when refresh itself fails. https://geminidesktop.app/en/blog/openrouter-oauth-pkce-tauri-desktop-2026
4. Conductor-style alternative: just embed the provider's subscription **OAuth (Claude/Codex)** login in-app rather than API keys.

**Verdict for Entry Desktop:** tauri-plugin-deep-link + custom scheme + PKCE, verifier in webview storage, refresh interceptor in Rust.

---

## Synthesis: what to copy into Entry Desktop

| Pattern | Source | Why |
|---|---|---|
| Timeline of collapsible tool-call cards in one chat column | Cline, Zed, OpenCode | Proven scan-friendly; avoids pane sprawl |
| Permission dialog: Allow/Deny once + **Always for tool** + **Always for pattern** (regex extracted from input) | Zed | Escalates trust incrementally; kills repeat prompts |
| Auto-approve tiers **per tool category** with limits | Cline | Granular, understandable, one settings screen |
| Checkpoints w/ Compare + Restore (task-only vs files+task) attached to each agent turn | Cline, ZCode | Makes autonomy safe; pairs with auto-approve |
| Inline diff review panel; accept/reject without leaving chat | Warp, Conductor | Highest acceptance-rate UX |
| Worktree-per-agent as navigation; status badges (running / needs-approval / done) on cards | Conductor, Crystal | Clean parallelism; "needs-approval" is the single most important status |
| Typed append-only event log as the UI's source of truth (Action/Observation/Reject/Error/Pause/Condensation events) | OpenHands | Streaming, replay, and resume fall out for free |
| Global toggles for tool-detail & reasoning visibility; `@` file mentions; `!` shell injection; `/` command palette with fork/compact | OpenCode, Warp, ZCode | Composer does triple duty as context, control, navigation |
| Blocks as context (attach any prior block) + "charms" status chips (cwd, branch) | Warp | Context and state without dialogs |
| Answer blocking questions from phone (Bot Channel) | ZCode | Unblocks long runs |
| Model picker: curated list + "auto" option + per-response cost shown | Warp | Cost transparency reduces selector anxiety |
| Dark-UI polish: monospace for tool output, semantic status colors, subtle motion on expand/collapse of tool cards, dotted-line checkpoint connectors | Cline/Warp/Zed aesthetics | The "neat" feel = dense info, quiet chrome, one accent color for agent state |
