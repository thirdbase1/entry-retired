# Entry Desktop

Entry Desktop is the native desktop foundation for Entry: a Tauri 2 application with a React/TypeScript UI and a Rust native core.

## Architecture

- **UI:** React + TypeScript + Vite
- **Desktop shell:** Tauri 2
- **Native core:** Rust
- **Future harness:** Rust modules for process lifecycle, terminal/PTY, filesystem, approvals, MCP process management, workspace state, and local sandboxing
- **Agent compatibility:** existing Entry agent/provider logic remains the source of truth initially; desktop-specific native capabilities are introduced behind explicit boundaries.

## Development

Prerequisites:

- Node.js 22+
- pnpm 10+
- Rust stable
- Tauri 2 prerequisites for your operating system

Install and run:

```bash
pnpm install
pnpm tauri dev
```

Check the Rust side:

```bash
cd src-tauri
cargo fmt --check
cargo check
cargo test
```

Build:

```bash
pnpm build
pnpm tauri build
```

## Repository direction

Read [goal.md](./goal.md) before changing the architecture. It describes the target desktop harness, migration boundaries from `entry-agents`, and the learning objectives.

Record discoveries and mistakes in [lessonlearn.md](./lessonlearn.md).


## Native agent configuration

The current model plugin uses an OpenAI-compatible chat-completions endpoint. Configure the desktop process with the variables in [`.env.example`](./.env.example):

- `ENTRY_MODEL_BASE_URL`
- `ENTRY_MODEL_API_KEY`
- `ENTRY_MODEL_ID`

The agent execution tools do not use a cloud sandbox. Shell commands and workspace file operations run as native laptop processes through the Rust runtime. Transient model/network failures are retried with bounded backoff; task state is persisted under `.entry/tasks/` so a failed request can be resumed.
