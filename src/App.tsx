import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  bash,
  readFile,
  commandApprovalRequired,
  workspaceInfo,
  onProcessOutput,
  type WorkspaceInfo,
  type BashResult,
  type ReadResult,
} from "./native";
import {
  sessionInfo,
  signOut,
  modelCatalog,
  type SessionInfo,
  type CatalogModel,
} from "./auth";
import { LoginScreen } from "./LoginScreen";

interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

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
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [command, setCommand] = useState("git status --short");
  const [result, setResult] = useState<BashResult | null>(null);
  const [readPath, setReadPath] = useState("README.md");
  const [readOut, setReadOut] = useState<ReadResult | null>(null);
  const [chip, setChip] = useState<"ok" | "fail" | null>(null);
  const [chipText, setChipText] = useState("");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");

  useEffect(() => {
    sessionInfo()
      .then((s) => {
        setSession(s);
        setSessionLoaded(true);
        if (s.signedIn) {
          modelCatalog()
            .then((m) => {
              setModels(m);
              if (m.length > 0) setSelectedModel((cur) => cur || m[0].id);
            })
            .catch(() => setModels([]));
        }
      })
      .catch(() => setSessionLoaded(true));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onProcessOutput((stream, text) => {
      setLines((prev) => [...prev.slice(-500), { stream, text }]);
    }).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, []);

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

  function refreshSession() {
    sessionInfo().then((s) => {
      setSession(s);
      if (s.signedIn) {
        modelCatalog()
          .then((m) => {
            setModels(m);
            if (m.length > 0) setSelectedModel((cur) => cur || m[0].id);
          })
          .catch(() => setModels([]));
      }
    });
  }

  if (!sessionLoaded) {
    return (
      <main className="shell">
        <div className="login-waiting" style={{ margin: "auto" }}>
          <span className="spinner" /> Loading…
        </div>
      </main>
    );
  }

  if (!session?.signedIn) {
    return <LoginScreen onSignedIn={refreshSession} />;
  }
  async function runAgent() {
    if (!workspace.trim() || !request.trim()) return;
    setBusy(true);
    setEvents([]);
    const nextTaskId = crypto.randomUUID();
    localStorage.setItem("entry-desktop-task-id", nextTaskId);
    try {
      const result = await invoke<string>("run_agent", {
        taskId: nextTaskId,
        request,
        workspace,
        modelId: selectedModel || null,
        reasoningEffort: reasoningEffort || null,
      });
      setStatus(result);
    } catch (error) {
      setStatus(String(error));
      setBusy(false);
    }
  }

  async function resumeLastTask() {
    if (!workspace.trim()) return;
    const savedTaskId = localStorage.getItem("entry-desktop-task-id");
    if (!savedTaskId) return;
    setBusy(true);
    setEvents([]);
    try {
      const result = await invoke<string>("run_agent", {
        taskId: savedTaskId,
        request: "resume",
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

  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const detectWorkspace = useCallback(async () => {
    try {
      setWsInfo(await workspaceInfo("."));
    } catch {
      setWsInfo(null);
    }
  }, []);

  const execute = useCallback(async () => {
    setLines([]);
    setResult(null);
    setBusy(true);
    try {
      if (await commandApprovalRequired(command)) {
        setStatus("Refused: command matches a dangerous pattern (runtime approval gate)");
        return;
      }
      const r = await bash(command.trim());
      setResult(r);
      setChip(r.cancelled ? null : r.success ? "ok" : "fail");
      setChipText(
        r.cancelled
          ? "Cancelled"
          : `Exit ${r.exitCode ?? "?"} · ${r.durationMs}ms${r.truncated ? " · Truncated" : ""}`
      );
    } catch (err) {
      setStatus(`Refused or failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [command]);

  const doRead = useCallback(async () => {
    setReadOut(null);
    setBusy(true);
    try {
      setReadOut(await readFile(readPath.trim()));
      setStatus(`Read ${readPath}`);
    } catch (err) {
      setStatus(`Read refused: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [readPath]);

  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand">ENTRY</span>
        <span className="runtime">LOCAL RUNTIME · {busy ? "RUNNING" : "READY"}</span>
        <div className="topbar-right">
          <select
            className="model-picker"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            aria-label="Model"
          >
            {models.length === 0 && <option value="">No models available</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </select>
          <span className="account-chip" title={session.email ?? ""}>
            <span className="account-dot" />
            {session.username} · {session.plan ?? "free"} ·{" "}
            {session.creditBalanceCents != null
              ? `$${(session.creditBalanceCents / 100).toFixed(2)}`
              : "—"}
          </span>
          <button
            className="btn-ghost account-signout"
            onClick={async () => {
              await signOut();
              setSession(null);
            }}
          >
            Sign out
          </button>
        </div>
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

        <label>
          Reasoning effort
          <select
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value)}
          >
            <option value="">Model default</option>
            {(models.find((m) => m.id === selectedModel)?.reasoning_levels ?? ["low","medium","high"]).map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </label>

        <div className="actions">
          <button onClick={runAgent} disabled={busy || !workspace.trim() || !request.trim()}>
            {busy ? "Agent running…" : "Run agent"}
          </button>
          <button className="secondary" onClick={resumeLastTask} disabled={busy || !workspace.trim()}>Resume last task</button>
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

      <details className="dev-tools">
        <summary>Developer tools (bash · read · processes)</summary>
      <section className="hero">
        <span className="eyebrow">ENTRY DESKTOP / 0.3 · PHASE 1</span>
        <h1>Agent runtime, on your machine.</h1>
        <p>
          Upstream-compatible tool boundaries, native: workspace-contained bash
          with approval gating, ceilinged reads, streaming output, cancellation,
          and timeouts.
        </p>
        <button onClick={checkNativeCore} disabled={busy}>
          {busy ? "Working…" : "Check native core"}
        </button>
        <div className="status">
          {status}
          {chip && <span className={`chip ${chip}`}>{chipText}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>Bash</h2>
        <div className="row">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="command"
            aria-label="command"
            style={{ flex: 1 }}
          />
          <button onClick={execute} disabled={busy}>
            {busy ? "Running…" : "Run"}
          </button>
        </div>
        <pre className="output" aria-live="polite">
          {lines.length > 0 &&
            lines.map((l, i) => (
              <div key={i} className={l.stream === "stderr" ? "err" : "out"}>
                {l.text}
              </div>
            ))}
          {lines.length === 0 && result && (
            <>
              {result.stdout && <div className="out">{result.stdout}</div>}
              {result.stderr && <div className="err">{result.stderr}</div>}
            </>
          )}
          {lines.length === 0 && !result && "— no output yet —"}
        </pre>
      </section>

      <section className="panel">
        <h2>Read (ceilinged + boundary-wrapped)</h2>
        <div className="row">
          <input
            value={readPath}
            onChange={(e) => setReadPath(e.target.value)}
            placeholder="workspace-relative path"
            aria-label="file path"
            style={{ flex: 1 }}
          />
          <button onClick={doRead} disabled={busy}>
            Read
          </button>
        </div>
        {readOut && (
          <div className="ws">
            <div>
              lines {readOut.startLine}–{readOut.endLine} of {readOut.totalLines}
              {readOut.truncated && " · truncated"}
              {readOut.nextOffset !== null && ` · next offset: ${readOut.nextOffset}`}
            </div>
            <pre className="output">{readOut.content}</pre>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Workspace</h2>
        <button onClick={detectWorkspace}>Detect workspace</button>
        {wsInfo && (
          <ul className="ws">
            <li>root: {wsInfo.root}</li>
            <li>git repo: {wsInfo.isGitRepo ? "yes" : "no"}</li>
            {wsInfo.gitBranch && <li>branch: {wsInfo.gitBranch}</li>}
            <li>package.json: {wsInfo.hasPackageJson ? "yes" : "no"}</li>
            <li>Cargo.toml: {wsInfo.hasCargoToml ? "yes" : "no"}</li>
          </ul>
        )}
      </section>

      <section className="grid">
        <article>
          <strong>Rust core</strong>
          <span>Native process and OS boundary.</span>
        </article>
        <article>
          <strong>Local workspace</strong>
          <span>Direct filesystem and git access.</span>
        </article>
        <article>
          <strong>Agent harness</strong>
          <span>Plan → tools → observe → verify → respond.</span>
        </article>
      </section>
      </details>
    </main>
  );
}
