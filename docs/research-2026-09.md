# Research Brief: Plugin Architectures, Agent Desktop UI Patterns, and Tauri 2 Windows Build Readiness

_Compile date: Sep 30, 2026. All URLs cited inline. Confidence flags noted where sources are weak or dated._

---

## 1. DeepSeek's open-source repos and "everything is a plugin" architecture

### 1.1 The deepseek-ai GitHub org

The org is at https://github.com/deepseek-ai (repo list: https://github.com/orgs/deepseek-ai/repositories). Confirmed repos:

- **DeepSeek-V3** — the flagship open MoE model (671B total / 37B activated params, MLA + DeepSeekMoE, FP8 training, auxiliary-loss-free load balancing). It is a model/training repo, not an agent runtime. https://github.com/deepseek-ai/DeepSeek-V3
- **open-infra-index** and associated training-infra work — bidirectional pipeline parallelism for V3/R1 training (computing-communication overlap). Same org listing above.
- **DeepSeek Harness** — described by the org listing as "Everything is a Plugin" (TypeScript, MIT). Two independent secondary sources corroborate its existence and architecture (the org repo listing, and a detailed third-party deep-dive at https://github.com/RenatoMignone/inside-deepseek-harness). ⚠️ Caveat: I could not load the primary repo README directly in this session; the deep-dive author states claims were checked against upstream master (commit b150a55, Aug 2026) and that upstream warns of breaking changes ("developer preview"). Treat specifics as directional, verify against the live repo before designing against it.

### 1.2 The "everything is a plugin" architecture (DeepSeek Harness)

Source: https://github.com/RenatoMignone/inside-deepseek-harness (third-party analysis; matches the org's own tagline).

Key architecture points worth stealing for Entry Desktop:

- **Cordis runtime substrate**: plugins contribute *services*, *typed events*, and *reversible effects* to a shared context. There is no privileged core — the model adapter, tool registry, session log, and even the default agent loop are themselves plugins.
- **Capability seam pattern**: each capability separates (a) service definition, (b) provider, (c) consumer (e.g., a model-facing tool). This is what lets a provider move execution to another environment without rewriting consumers — directly relevant to Entry Desktop's Rust-core / WebView-UI split.
- **Profiles/bundles**: a running `dsh` is an ordered plugin tree; profiles select bundles (`dsh-base` shared runtime, `dsh-web-app` / `dsh-headless` product surfaces). Config layers can be replaced via profile / home / CLI patches.
- **Durable state**: sessions are append-only event logs (JSONL/SQLite) with derived projections, replay, and resume — not an in-memory `messages[]`.
- **Tool governance pipeline**: tools pass through typed I/O, approvals, monotonic guards, wrappers, finalization, and observation — rather than direct unguarded callback execution.
- **Execution boundaries**: fail-closed filesystem confinement; sandboxed execution; opt-in parallel calls; owner-scoped jobs; child agents/subagents.
- **Repo layout convention**: `apps/` (UI entry points), `packages/` (capability modules + runtime services), `docs/`, `examples/`, `vendor/`, `python/`, `native/`.

**Takeaway for Entry Desktop**: model the Tauri Rust core as a plugin-tree runtime where the agent loop, tool registry, permission system, and event log are all plugins mounted into a shared context with typed events. Session state as append-only events makes UI replay/time-travel and resume nearly free.

### 1.3 Vectorizing plugin systems across agent runtimes

Cross-repo comparison of how "plugins" actually work:

| System | Extension mechanism | Integration | Sources |
|---|---|---|---|
| DeepSeek Harness | Cordis plugins: services + typed events + lifecycle (init/start/stop/dispose) | In-process DI; profiles compose bundles | https://github.com/RenatoMignone/inside-deepseek-harness |
| OpenHands SDK | ToolDefinition/ToolExecutor classes (Action/Observation pydantic models) + MCP servers auto-discovered from `mcp_config` | REST/WebSocket agent-server; frontend in separate repo | https://docs.openhands.dev/sdk/arch/tool-system |
| Goose (Block) | MCP extensions (70+), skills, "Recipes" as portable YAML workflows; MCP Apps render interactive UI in-app | Rust core; desktop app/CLI/API surfaces | https://block.github.io/goose/ |
| Open Interpreter (new Rust version) | `/harness` swappable agent-harness emulation (claude-code, kimi-code, deepseek-tui, swe-agent, minimal…); MCP, ACP, AGENTS.md, `.agents/skills` dirs | Codex-exec protocol compatible; ACP agent for editors | https://github.com/openinterpreter/open-interpreter |
| Cline | Tools with per-call approval gates; ACP server mode; auto-approve toggles per session/launch | VS Code extension + CLI + ACP | https://github.com/cline/cline/blob/main/docs/usage/acp.mdx |

Convergent pattern across all five: **MCP as the tool-calling standard** + **ACP (Agent Client Protocol) as the client/editor protocol** + skills/prompt-file conventions (AGENTS.md / `.agents/skills`). A new agent desktop in 2026 should speak MCP (tools) and consider ACP (embedding/embedding-in), and use shared skill directories rather than proprietary formats (Open Interpreter explicitly states this portability policy: https://github.com/openinterpreter/open-interpreter).

Open Interpreter's older Python architecture (still documented via deepwiki) is a cleaner minimal template: stateful core (`interpreter`) strictly separated from stateless terminal interface, language backends registered in a registry, docstrings becoming part of the system message. https://deepwiki.com/openinterpreter/open-interpreter/11-development-and-contributing

---

## 2. Best-in-class open-source AI desktop agent apps: interface patterns

### 2.1 Goose by Block — closest reference architecture

- Native desktop app (macOS/Linux/Windows), CLI, and embeddable API; core built in Rust. https://block.github.io/goose/
- **Chat interface anatomy** (https://block-goose.mintlify.app/guides/desktop-app): message history; input area with markdown; **collapsible tool-execution results**; thinking indicators during processing. Sessions view with search, pinning, rename, and "session insights" (statistics/activity).
- **Approvals**: `GOOSE_MODE=approve|smart_approve` controls which tools run without confirmation; sandbox mode; prompt-injection detection; an "adversary reviewer" agent that watches for unsafe actions (https://block.github.io/goose/ , https://goose-docs.ai/blog/2026/02/23/goose-v1-25-0).
- **MCP Apps** (v1.25.0): MCP extensions render full interactive HTML/JS UIs inline in chat via `@mcp-ui/client` AppRenderer, with fallback request handlers back to the MCP server — a strong precedent for letting tools render rich UI in the transcript (https://goose-docs.ai/blog/2026/02/23/goose-v1.25-0).
- **Streaming**: terminal markdown rendering uses a `MarkdownBuffer` state machine that only flushes complete markdown constructs — avoids flashing half-bold/half-code-block during streaming. Worth copying for the WebView chat renderer.
- **Subagents** spawn in parallel, keeping the main conversation clean (https://block.github.io/goose/).
- Desktop app is Electron+React (`ui/desktop/src/main.ts`): https://github.com/block/goose/blob/main/ui/desktop/src/main.ts — but the core/desktop split is still a useful seam model for Tauri.

### 2.2 Cline — approval UX

- Per-tool approval prompts by default in ACP mode ("file edits and commands are approved through the client's permission UI. Nothing is auto-approved by default"), with per-session and per-launch auto-approve toggles; changes take effect on next tool call (https://github.com/cline/cline/blob/main/docs/usage/acp.mdx).
- CLI TUI: plan/act toggle, slash commands, file mentions, live tool approvals; `--yolo` mode skips approvals; NDJSON event streaming for programmatic consumption (https://raw.githubusercontent.com/cline/cline/main/apps/cli/README.md). The plan/act mode split (a mode where the agent only plans vs. only executes) is a widely-praised Cline pattern to adopt.
- Approval prompt shape: `Approve tool "<tool_name>" with input <preview>? [y/N]` — i.e., show tool name + input preview, default-deny.

### 2.3 OpenHands (ex-OpenDevin) — run transparency

- Splits frontend ("Agent Canvas", React/TS) from a Python SDK agent-server exposing conversations/events over REST+WebSocket (https://github.com/OpenHands/OpenHands/blob/main/AGENTS.md). Same architectural seam Entry Desktop has (WebView UI ↔ Rust core).
- GUI pitch centers on auditability: review diffs and code artifacts, parallel agent runs, sandboxed execution (https://www.openhands.dev/product/gui).
- Tool system: registry → tool instances → schema generation for the LLM → Action (validated input model) → Executor → Observation, with MCP tools wrapped into the same interface (https://docs.openhands.dev/sdk/arch/tool-system). The Action/Observation duality with a `visualize` property on Actions is a clean way to drive UI rendering per tool call.
- E2E tests key off real UI markers (`data-testid="chat-interface"`) and observation tokens appearing outside the user message — implies their event stream renders terminal observations as distinct transcript entries.

### 2.4 Jan / LM Studio / Chatbox — local-LLM desktop conventions

- Jan (open source, Apache 2.0 per newer docs; AGPL per some comparisons — verify on jan.ai): clean ChatGPT-style threads-in-sidebar UI, model selector per thread, per-thread system prompt/temperature/context settings, file drag-drop into messages, extension system with native MCP support, OpenAI-compatible local API on port 1337 (https://mljourney.com/jan-ai-the-open-source-local-llm-desktop-app-explained , https://dexiio.com/compare/jan-vs-lm-studio).
- LM Studio (proprietary, free): best-in-class **model discovery browser**, granular hardware controls (GPU offload layers), Developer tab to start the local server, OpenAI+Anthropic-compatible API on 1234 (https://markaicode.com/vs/lm-studio-vs-jan-ai).
- Common conventions to copy: sidebar of conversations/threads; model/provider picker inline; settings per-conversation; a dedicated "developer/server" surface; collapsible raw output.

### 2.5 Terminal/process streaming UI patterns (Warp / Raycast lineage)

Warp and Raycast are closed-source, so no repo citations; their established patterns visible in the OSS tools above: stream stdout/stderr into a monospace collapsible block per command; exit-code badges; completion-signal events rather than string polling; command blocks as first-class transcript objects. Goose's MarkdownBuffer (above) and OpenHands' ExecuteBashObservation-as-transcript-entry are the concrete OSS implementations of this.

### 2.6 Pattern checklist for Entry Desktop

1. Append-only event log per session; UI renders events as projections (enables replay, resume, time-travel).
2. Tool calls as collapsible transcript cards: name, input preview, streaming output, duration, exit status.
3. Approval modal = tool name + diff/input preview + allow-once / allow-always-for-this-tool / deny; default-deny.
4. Plan/act or propose/execute mode toggle.
5. MCP for tools; typed Action/Observation models so every tool result knows how to render itself.
6. Streaming markdown with construct-complete flushing.
7. Subagents/parallel jobs rendered as separate tracks, not interleaved into the main thread.

---

## 3. Tauri 2 Windows build readiness (2025/2026)

### 3.1 Current versions

- Tauri core crate is on the **2.x line**; 2.9.x shipped Oct–Dec 2025 (2.9.0 Oct 20, 2025; 2.9.5 Dec 9, 2025) and the line continued into 2.10.x (Feb 2026) and 2.11.x (Apr–Jun 2026) per the crate's changelog listing (https://lib.rs/crates/tauri/versions) and https://tauri.app/release/tauri-runtime/all-versions. JS API `@tauri-apps/api` tracks in lockstep (2.10.x Feb 2026: https://v2.tauri.app/release/@tauri-apps/api/all-versions).
- ⚠️ One third-party tutorial (https://tech-insider.org/tauri-tutorial-cross-platform-rust-app-2026/) claims "2.9.6, Dec 9 2025" and "runtime crate 2.11.5 July 2026"; lib.rs corroborates 2.9.5 (Dec 9, 2025) and the 2.11.x series but is the more authoritative source. Pin to whatever `cargo search tauri` returns at build time; the v2 API surface you develop against is stable across 2.9→2.11.
- MSRV around 1.86–1.94 depending on release (lib.rs table above). Keep CI on `dtolnay/rust-toolchain@stable`.

### 3.2 Windows prerequisites

Official prerequisites guide: https://tauri.app/start/prerequisites/ (v2). Windows needs:

1. **Microsoft C++ Build Tools** with "Desktop development with C++" workload (MSVC linker `link.exe` + Windows SDK). No full VS IDE needed:
   `winget install --id Microsoft.VisualStudio.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` (worked example: https://tauri.ninja/recipe.php?id=env-001)
2. **Rust, MSVC toolchain**: default triple must be `x86_64-pc-windows-msvc` (or `aarch64-pc-windows-msvc` on ARM). Never the GNU toolchain — known lib-linking failures with Tauri's resource bundling on windows-gnu (https://github.com/tauri-apps/tauri/issues/6724). Verify with `rustup default stable-msvc` if needed.
3. **WebView2 Runtime**: pre-installed on Windows 11 and Windows 10 1803+. Check registry value under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` (https://tauri.ninja/recipe.php?id=env-001); else `winget install Microsoft.EdgeWebView2Runtime`.
4. For ARM64 builds additionally install "C++ ARM64 build tools" in VS Installer and `rustup target add aarch64-pc-windows-msvc` (Tauri v1 guide, still accurate for tooling: https://v1.tauri.app/v1/guides/building/windows).
5. Practical hygiene: keep projects out of OneDrive-synced paths (thousands of `target/` files); first build 2–5 min (https://tauri.ninja/recipe.php?id=env-001 , https://vault.mikaelweiss.dev/vault/windows/tauri-setup-guide-for-windows).

### 3.3 Bundling: MSI (WiX) and NSIS

- `tauri build` on Windows produces by default `yourapp_x64.msi` (WiX Toolset v3) and `yourapp_x64-setup.exe` (NSIS), in `src-tauri/target/release/bundle/{msi,nsis}/` (walkthrough: https://techxcelerate.ntxm.org/docs/tauri/building--distribution/packaging-applications/windows).
- **WiX must be on PATH** for MSI; if missing, `tauri build` silently skips MSI and emits only NSIS (same source).
- MSI is Windows-build-only — no cross-compile path for MSI from macOS/Linux; use a Windows CI runner (same source).
- **NSIS can be cross-compiled** from Linux/macOS via `cargo-xwin` + LLD + NSIS: `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc` (same source).
- Newer Tauri 2.x added NSIS uninstaller icon/header-image support and PerMonitorV2 DPI awareness in the NSIS template (https://tauri.app/release/tauri-utils/all-versions , https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi).
- tauri-action defaults `updaterJsonPreferNsis` to true for v2 (use the NSIS setup.exe in updater JSON): https://github.com/tauri-apps/tauri-action README.

### 3.4 WebView2 deployment modes (`bundle.windows.webviewInstallMode`)

| mode | internet needed | size added | notes |
|---|---|---|---|
| `downloadBootstrapper` (default) | yes | 0 MB | small installer, downloads runtime at install time |
| `embedBootstrapper` | yes | ~1.8 MB | better Win7 compat |
| `offlineInstaller` | no | ~127 MB | for offline/corporate environments |
| `fixedVersion` | no | ~180 MB | ships a pinned WebView2 |
| `skip` | — | 0 MB | app fails opaquely on machines without WebView2 — avoid |

Sources: https://v1.tauri.app/v1/guides/building/windows and https://techxcelerate.ntxm.org/docs/tauri/building--distribution/packaging-applications/windows (v2 behavior unchanged for these modes).

### 3.5 Known pitfalls

- **windows-gnu toolchain**: resource-bundle linking errors (`+bundle` vs `+whole-archive`); use MSVC (https://github.com/tauri-apps/tauri/issues/6724).
- **VBSCRIPT disabled** on newer Windows 11 breaks WiX `light.exe` → MSI build fails; re-enable VBSCRIPT in Optional Features (https://tauri.ninja/recipe.php?id=env-001 , https://vault.mikaelweiss.dev/vault/windows/tauri-setup-guide-for-windows).
- **Windows 7/legacy**: WebView2 ≥110 unsupported; v109 is the last Win7-compatible runtime (https://github.com/tauri-apps/tauri/issues/8429). Probably out of scope for Entry Desktop.
- **MSIX / Microsoft Store**: Tauri v2 apps can fail WACK "Package Sanity Test" due to WebView2/runtime imports (kernel32!CreateProcessW, shell32!ShellExecuteW, cmd.exe); no config switch exists (https://techxcelerate.ntxm.org/docs/tauri/building--distribution/packaging-applications/windows).
- **Code signing is mandatory for real distribution**: unsigned → SmartScreen blocks, AV flags. Sign via `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars (.pfx); EV certs need hardware tokens; Azure Artifact Signing avoids tokens; MSIX via the Store is re-signed by Microsoft (same source).
- **IPC origin quirk**: windows created from non-http protocols (`data:` URLs) get empty Origin and IPC calls fail (https://github.com/tauri-apps/tauri/issues/11504) — irrelevant if you serve the frontend normally, but avoid `data:` windows.
- **webview2-com crate bumps** have been breaking for `with_webview` users across 2.x minors (e.g., 2.2.0 notes: https://v2.tauri.app/ja/release/tauri/v2.2.0) — if Entry Desktop pokes at the raw WebView2 COM surface, expect occasional breakage on upgrades.
- **32-bit/ARM64 installers are architecture-specific**; ship separate installers or custom NSIS arch-detection scripting (https://techxcelerate.ntxm.org/docs/tauri/building--distribution/packaging-applications/windows).

### 3.6 GitHub Actions workflow (tauri-action)

Canonical action: https://github.com/tauri-apps/tauri-action (README examples). Recommended shape for a 3-OS release on tag push:

```yaml
name: publish
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-latest,  target: aarch64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
          - { os: ubuntu-latest,  target: x86_64-unknown-linux-gnu }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Linux deps
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - uses: actions/setup-node@v4
        with: { node-version: lts/* }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: '${{ matrix.target }}' }
      - run: npm install   # or pnpm/bun install
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}       # updater signing
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: v__VERSION__
          releaseName: 'Entry Desktop v__VERSION__'
          args: --target ${{ matrix.target }}
```

Key notes from the action README (https://github.com/tauri-apps/tauri-action):
- The action can test builds on PRs, upload to an existing release, or create the release itself.
- Windows runner (`windows-latest`) has MSVC preinstalled; nothing extra needed for NSIS. WiX for MSI is bundled by the runner tooling in current images, but verify MSI output appears (silent-skip pitfall, §3.3).
- Updater JSON prefers NSIS setup.exe on v2.
- Matrix `fail-fast: false` so one OS failure doesn't cancel the rest.

### 3.7 Readiness verdict

Entry Desktop's Windows path is low-risk: Tauri 2.x stable is mature, NSIS+MSI bundling and tauri-action are battle-tested, and WebView2 is preinstalled on all supported Windows versions. The only real project decisions are (a) `webviewInstallMode` choice (`downloadBootstrapper` default is fine for a dev-tool audience; `offlineInstaller` for enterprise), (b) code-signing certificate procurement (SmartScreen makes unsigned builds painful), and (c) adding a Windows job to CI from day one so regressions surface early.

---

## Source index

- https://github.com/deepseek-ai/DeepSeek-V3
- https://github.com/orgs/deepseek-ai/repositories
- https://github.com/RenatoMignone/inside-deepseek-harness
- https://github.com/openinterpreter/open-interpreter
- https://deepwiki.com/openinterpreter/open-interpreter/11-development-and-contributing
- https://block.github.io/goose/
- https://goose-docs.ai/blog/2026/02/23/goose-v1.25-0
- https://block-goose.mintlify.app/guides/desktop-app
- https://github.com/block/goose/blob/main/ui/desktop/src/main.ts
- https://github.com/cline/cline/blob/main/docs/usage/acp.mdx
- https://raw.githubusercontent.com/cline/cline/main/apps/cli/README.md
- https://github.com/OpenHands/OpenHands/blob/main/AGENTS.md
- https://docs.openhands.dev/sdk/arch/tool-system
- https://www.openhands.dev/product/gui
- https://mljourney.com/jan-ai-the-open-source-local-llm-desktop-app-explained
- https://markaicode.com/vs/lm-studio-vs-jan-ai
- https://dexiio.com/compare/jan-vs-lm-studio
- https://local-llm.net/compare/lm-studio-vs-jan-vs-gpt4all
- https://tauri.app/start/prerequisites/ (v2 prerequisites)
- https://lib.rs/crates/tauri/versions
- https://tauri.app/release/tauri-runtime/all-versions
- https://v2.tauri.app/release/@tauri-apps/api/all-versions
- https://tauri.ninja/recipe.php?id=env-001
- https://techxcelerate.ntxm.org/docs/tauri/building--distribution/packaging-applications/windows
- https://v1.tauri.app/v1/guides/building/windows
- https://github.com/tauri-apps/tauri/issues/6724
- https://github.com/tauri-apps/tauri/issues/8429
- https://github.com/tauri-apps/tauri/issues/11504
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
- https://github.com/tauri-apps/tauri-action
- https://v2.tauri.app/ja/release/tauri/v2.2.0
