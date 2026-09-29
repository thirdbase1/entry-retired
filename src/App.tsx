import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type AgentEvent = {
  task_id: string;
  kind: string;
  message: string;
};

export function App() {
  const [workspace, setWorkspace] = useState("");
  const [request, setRequest] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Native runtime ready");
  const [taskId, setTaskId] = useState(() => localStorage.getItem("entry-desktop-task-id") ?? crypto.randomUUID());

  useEffect(() => {
    let dispose: (() => void) | undefined;
    listen<AgentEvent>("entry://agent-event", (event) => {
      setEvents((current) => [...current, event.payload]);
      setStatus(event.payload.kind);
      if (event.payload.kind === "task.completed" || event.payload.kind === "task.error") {
        setBusy(false);
      }
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, []);

  async function runAgent() {
    if (!workspace.trim() || !request.trim()) return;
    setBusy(true);
    setEvents([]);
    const nextTaskId = crypto.randomUUID();
    localStorage.setItem("entry-desktop-task-id", nextTaskId);
    setTaskId(nextTaskId);
    try {
      const result = await invoke<string>("run_agent", {
        taskId: nextTaskId,
        request,
        workspace,
      });
      setStatus(result);
    } catch (error) {
      setStatus(String(error));
      setBusy(false);
    }
  }

  async function checkNativeCore() {
    try {
      setStatus(await invoke<string>("native_status"));
    } catch {
      setStatus("Native command unavailable");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand">ENTRY</span>
        <span className="runtime">LOCAL RUNTIME · {busy ? "RUNNING" : "READY"}</span>
      </header>

      <section className="workspace-panel">
        <div className="eyebrow">NATIVE AGENT</div>
        <h1>Build on your machine.</h1>
        <p>Entry now runs its tools, files, processes, and task state locally. The model remains a replaceable network plugin.</p>

        <label>
          Workspace
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="C:\path\to\repo" />
        </label>

        <label>
          Task
          <textarea value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Ask Entry to inspect, change, and verify this repository…" rows={5} />
        </label>

        <div className="actions">
          <button onClick={runAgent} disabled={busy || !workspace.trim() || !request.trim()}>
            {busy ? "Agent running…" : "Run agent"}
          </button>
          <button className="secondary" onClick={checkNativeCore}>Check runtime</button>
        </div>
      </section>

      <section className="activity">
        <div className="activity-head">
          <span>Execution</span>
          <span>{status}</span>
        </div>
        {events.length === 0 ? (
          <div className="empty">No task activity yet.</div>
        ) : (
          events.map((event, index) => (
            <article key={index}>
              <span className="event-kind">{event.kind}</span>
              <p>{event.message}</p>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
