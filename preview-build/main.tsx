import { createRoot } from "react-dom/client";
import { Workspace } from "../src/Workspace";
import "../src/styles.css";

// The REAL Workspace component with the REAL stylesheet, rendered for the
// product shot. Only the Tauri IPC bridge is stubbed (invoke/listen), because
// no native host exists in a headless browser — every component, class and
// token below is the shipped code.

type Cb = (payload: unknown) => void;
let nextId = 1;
const callbacks = new Map<number, Cb>();
const eventNames = new Map<number, string>();

const sessionEvents = [
  {
    kind: "turn",
    status: "completed",
    at: Date.now() - 120000,
    records: [
      { kind: "message.user", data: { text: "Run the test suite and fix the failing auth tests." } },
      { kind: "tool.started", data: { message: "Running bash: cargo test" } },
      { kind: "approval/asked", data: { tool: "bash" } },
      { kind: "approval/decided", data: { outcome: "allowed-once" } },
      {
        kind: "message.tool",
        data: { text: "running 53 tests\ntest result: ok. 53 passed; 0 failed; 0 ignored\n\nfinished in 0.84s" },
      },
      {
        kind: "message.assistant",
        data: {
          text: "All 53 tests pass. The auth failures came from a race in the session refresh path: a transient backend error was clearing the local session instead of degrading it. I fixed the branch so only a real 401 signs you out.",
          toolCalls: [{ name: "bash" }, { name: "read_file" }],
        },
      },
    ],
  },
  {
    kind: "turn",
    status: "running",
    at: Date.now() - 8000,
    records: [
      { kind: "message.user", data: { text: "Now wire the sign-out revocation to the server." } },
      { kind: "tool.started", data: { message: "Running read_file: src-tauri/src/backend.rs" } },
    ],
  },
];

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback(cb: Cb) {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
  async invoke(cmd: string, args?: Record<string, unknown>) {
    if (cmd === "session_events") return sessionEvents;
    if (cmd === "plugin:event|listen") {
      const id = nextId++;
      eventNames.set(id, String((args as { event?: string })?.event ?? ""));
      return id;
    }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "job_list") return [];
    console.log("invoke", cmd, args);
    return null;
  },
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

// Drive the running turn's stream exactly as the Rust core emits it.
const emitEvent = () => {
  const payload = {
    task_id: "session-1",
    kind: "tool.started",
    message: "read_file: src-tauri/src/backend.rs",
  };
  for (const [id, name] of eventNames) {
    if (name !== "entry://agent-event") continue;
    const cb = callbacks.get(id);
    try {
      cb?.({ event: name, id, payload });
    } catch { /* noop */ }
  }
};

// Seed the persisted workspace (as the real app does after first use),
// then let the app mount and push real stream frames.
localStorage.setItem("ventry-workspace", "C:\\Users\\nathaniel\\dev\\entry-desktop");
localStorage.setItem("ventry-session-id", "session-1790769500000");
setTimeout(() => {
  for (let i = 0; i < 3; i++) emitEvent();
}, 300);

createRoot(document.getElementById("root")!).render(
  <Workspace
    username="nathanieljohny32-9143"
    plan="free"
    balance="$1.00"
    model="gpt-5.6-luna"
    models={[{ id: "gpt-5.6-luna" }, { id: "qwen3.8-max-free" }]}
    onModel={() => {}}
    onSignOut={() => {}}
  />,
);
