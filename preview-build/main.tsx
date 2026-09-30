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
    id: "t1",
    status: "completed",
    at: Date.now() - 120000,
    records: [
      { kind: "message.user", seq: 1, data: { text: "Run the test suite and fix the failing auth tests." } },
      {
        kind: "message.assistant",
        seq: 2,
        ignorable: false,
        data: {
          text: null,
          toolCalls: [{ id: "c1", name: "bash", arguments: "{\"cmd\":\"cargo test\"}" }],
        },
      },
      { kind: "tool.started", seq: 3, ignorable: true, data: { message: "Running bash" } },
      { kind: "approval/asked", seq: 4, data: { callId: "c1", tool: "bash", reason: "Command needs approval: cargo test" } },
      { kind: "approval/decided", seq: 5, data: { callId: "c1", outcome: "allowed-once" } },
      {
        kind: "message.tool",
        seq: 6,
        data: { callId: "c1", text: "running 53 tests\ntest result: ok. 53 passed; 0 failed; 0 ignored\n\nfinished in 0.84s" },
      },
      {
        kind: "message.assistant",
        seq: 7,
        data: {
          text: "All **53 tests pass**. The auth failures came from a race in the session refresh path:\n\n- A transient backend error was clearing the local session\n- Instead of degrading it\n\nI fixed the branch so only a real `401` signs you out.\n\n```rust\nfn main() { println!(\"hello\"); }\n```",
          toolCalls: [],
        },
      },
    ],
  },
  {
    kind: "turn",
    id: "t2",
    status: "running",
    at: Date.now() - 8000,
    records: [
      { kind: "message.user", seq: 8, data: { text: "Now wire the sign-out revocation to the server." } },
      {
        kind: "message.assistant",
        seq: 9,
        data: {
          text: null,
          toolCalls: [{ id: "c2", name: "read_file", arguments: "{\"path\":\"src-tauri/src/backend.rs\"}" }],
        },
      },
    ],
  },
];

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback(cb: Cb) {
    const id = nextId++;
    callbacks.set(id, cb);
    // Real Tauri v2 exposes the callback as a window global `_<id>` and the
    // Rust runtime delivers events by calling it with the Event object.
    (window as unknown as Record<string, unknown>)[`_${id}`] = (eventObj: unknown) => cb(eventObj as never);
    return id;
  },
  async invoke(cmd: string, args?: Record<string, unknown>) {
    if (cmd === "session_events") return sessionEvents;
    if (cmd === "plugin:event|listen") {
      // Tauri's listen returns the callback id it registered; events are keyed
      // by that same id, so the name map must use args.handler.
      const id = Number((args as { handler?: number })?.handler ?? nextId++);
      eventNames.set(id, String((args as { event?: string })?.event ?? ""));
      return id;
    }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "job_list") return [];
    if (cmd === "run_agent") {
      // Faithful harness: stream frames like the Rust core, request an
      // approval mid-turn, then settle so busy/resume behavior is exercisable.
      setTimeout(() => {
        emit("entry://agent-event", { task_id: "s", kind: "turn.started", message: "Planning…" });
        emit("entry://agent-event", { task_id: "s", kind: "tool.started", message: "glob: **/*.rs" });
        emit("entry://approval-request", {
          sessionId: "session-1790769500000",
          callId: "call-harness-1",
          toolName: "bash",
          reason: "cargo test",
          createdAt: Date.now(),
        });
      }, 200);
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve("Harness turn complete."), 1600);
      });
    }
    if (cmd === "answer_approval") return true;
    console.log("invoke", cmd, args);
    return null;
  },
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

// Drive the running turn's stream exactly as the Rust core emits it.
const emit = (name: string, payload: unknown) => {
  for (const [id, n] of eventNames) {
    if (n !== name) continue;
    const cb = callbacks.get(id);
    try {
      cb?.({ event: name, id, payload });
    } catch { /* noop */ }
  }
};

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
// ?fresh=1 renders the pre-first-message hero (EmptyHero/HeroShell).
const fresh = new URLSearchParams(location.search).has("fresh");
if (!fresh) {
  localStorage.setItem("entry-workspace", "C:\\Users\\nathaniel\\dev\\entry-desktop");
  localStorage.setItem("entry-session-id", "session-1790769500000");
  setTimeout(() => {
    for (let i = 0; i < 3; i++) emitEvent();
  }, 300);
}

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
