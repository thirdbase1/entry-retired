import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  answerApproval,
  interruptAgent,
  runAgent,
  sessionEvents,
  type ApprovalRequest,
  type TurnProjection,
  type TurnRecord,
} from "./agent_api";

interface Props {
  username: string;
  plan: string;
  balance: string;
  model: string;
  models: { id: string; name?: string }[];
  onModel: (id: string) => void;
  onSignOut: () => void;
}

const SESSION_KEY = "ventry-session-id";
const WORKSPACE_KEY = "ventry-workspace";

type StreamLine = { stream: string; text: string };

/**
 * The conversation surface, distilled from the DeepSeek harness client:
 * sidebar (session + workspace), a single 748px chat column with turn
 * trigger rows, right-aligned user bubbles, tool results as code blocks,
 * the running status with divider line, and a floating panel-radius
 * composer card. Approval takes the composer's place as its own card.
 */
export function Workspace({ username, plan, balance, model, models, onModel, onSignOut }: Props) {
  const [workspace, setWorkspace] = useState(() => localStorage.getItem(WORKSPACE_KEY) ?? "");
  const [sessionId] = useState(() => {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh = `session-${Date.now()}`;
    localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<TurnProjection[]>([]);
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const [notice, setNotice] = useState("");
  const [composerMode, setComposerMode] = useState<"queue" | "steer">("queue");
  const [showJobs, setShowJobs] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live agent events → running status + execution stream.
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<{ kind: string; message: string }>("entry://agent-event", (e) => {
      setLines((prev) => [...prev.slice(-300), { stream: e.payload.kind, text: e.payload.message }]);
      if (e.payload.kind === "task.completed" || e.payload.kind === "task.error") {
        setBusy(false);
      }
    }).then((un) => {
      off = un;
    });
    return () => off?.();
  }, []);

  // Approval requests take over the composer.
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<ApprovalRequest>("entry://approval-request", (e) => setPending(e.payload)).then((un) => {
      off = un;
    });
    return () => off?.();
  }, []);

  // The durable projection is the source of truth; reload when a turn settles.
  useEffect(() => {
    if (!workspace) return;
    sessionEvents(workspace, sessionId)
      .then(setTurns)
      .catch(() => setTurns([]));
  }, [workspace, sessionId, busy]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, lines]);

  async function send() {
    const text = draft.trim();
    if (!text || !workspace.trim()) return;
    if (busy && composerMode === "queue") {
      setNotice("A turn is already running — switch Enter to steer to interrupt it.");
      return;
    }
    if (busy && composerMode === "steer") {
      await interruptAgent(sessionId);
    }
    setDraft("");
    setBusy(true);
    setNotice("");
    try {
      await runAgent({
        taskId: sessionId,
        sessionId,
        request: text,
        workspace,
        modelId: model || null,
        reasoningEffort: null,
      });
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "allow" | "reject" | "cancel") {
    if (!pending) return;
    await answerApproval(sessionId, pending.callId, decision);
    setPending(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && pending) {
      e.preventDefault();
      decide("reject");
      return;
    }
    // Enter submits; Shift+Enter is a newline. IME composition is respected.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (pending) decide("allow");
      else send();
    }
  }

  function newSession() {
    localStorage.setItem(SESSION_KEY, `session-${Date.now()}`);
    setTurns([]);
    setLines([]);
    window.location.reload();
  }

  const toolLines = lines.filter((l) => l.stream.startsWith("tool."));

  return (
    <div className="app">
      <aside className="side">
        <div className="side-head">
          <img src="/logos/entry.svg" alt="" className="side-logo" />
          <span>Entry</span>
        </div>
        <button className="side-new" onClick={newSession}>
          New session
        </button>
        <div className="side-label">Session</div>
        <div className="side-item">{sessionId.replace("session-", "#")}</div>
        <div className="side-label">Workspace</div>
        <input
          className="side-input"
          value={workspace}
          onChange={(e) => {
            setWorkspace(e.target.value);
            localStorage.setItem(WORKSPACE_KEY, e.target.value);
          }}
          placeholder="C:\path\to\repo"
        />
        <div className="side-foot">
          <div className="side-user" title={username}>
            {username}
          </div>
          <div className="side-plan">
            {plan} · {balance}
          </div>
          <button className="side-out" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="chat-head">
          <select
            className="model-picker"
            value={model}
            onChange={(e) => onModel(e.target.value)}
            aria-label="Model"
          >
            {models.length === 0 && <option value="">No models</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </select>
          <span className={`run-state${busy ? " live" : ""}`}>{busy ? "running" : "ready"}</span>
          <button className="head-btn" onClick={() => setShowJobs((v) => !v)}>
            Jobs
          </button>
          {busy && (
            <button className="head-btn danger" onClick={() => interruptAgent(sessionId)}>
              Stop
            </button>
          )}
        </header>

        {showJobs && (
          <div className="jobs-pop">
            {toolLines.length === 0 ? (
              <span className="jobs-empty">No background work yet.</span>
            ) : (
              toolLines.slice(-8).map((l, i) => (
                <div key={i} className="jobs-row">
                  <span className="jobs-kind">{l.stream}</span>
                  <span className="jobs-text">{l.text.slice(0, 90)}</span>
                </div>
              ))
            )}
          </div>
        )}

        <div className="transcript" ref={scrollRef}>
          <div className="chat-column">
            {turns.length === 0 && !busy && (
              <div className="empty-state">
                <h2>What should Entry work on?</h2>
                <p>
                  Point the workspace at a repository, then describe the task. Entry works
                  natively on this machine and asks before running anything dangerous.
                </p>
              </div>
            )}

            {turns.map((turn, ti) =>
              turn.kind === "turn" ? (
                <TurnView key={ti} turn={turn} />
              ) : (
                <div key={ti} className="rec-line">
                  {String((turn as unknown as Record<string, unknown>).kind ?? "")}
                </div>
              ),
            )}

            {busy && (
              <div className="running">
                <div className="running-divider" />
                <div className="running-content">
                  <span className="running-dot" />
                  <span className="running-text">
                    {lines.length > 0 ? lines[lines.length - 1].text.slice(0, 120) : "Working…"}
                  </span>
                </div>
                {lines.slice(-12).map((l, i) => (
                  <div key={i} className="live-line">
                    <span className="live-kind">{l.stream}</span>
                    <span className="live-text">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="composer-root">
          {notice && <div className="notice">{notice}</div>}
          {pending ? (
            <div className="approval">
              <div className="approval-strip">Approval required</div>
              <div className="approval-body">
                <div className="approval-headline">
                  Run <code>{pending.toolName}</code>?
                </div>
                <div className="approval-command">{pending.reason}</div>
              </div>
              <div className="approval-actions">
                <span className="approval-hint">
                  Enter = allow · Esc = reject · no answer in 2 min denies
                </span>
                <button className="btn-reject" onClick={() => decide("reject")}>
                  Reject
                </button>
                <button className="btn-allow" onClick={() => decide("allow")}>
                  Allow once
                </button>
              </div>
            </div>
          ) : (
            <div className="composer">
              <textarea
                className="composer-input"
                value={draft}
                rows={1}
                placeholder="Describe what you want Entry to do…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={!workspace.trim()}
              />
              <div className="composer-bar">
                <label className="composer-mode">
                  Enter while busy
                  <select
                    value={composerMode}
                    onChange={(e) => setComposerMode(e.target.value as "queue" | "steer")}
                  >
                    <option value="queue">queue</option>
                    <option value="steer">steer</option>
                  </select>
                </label>
                <button className="btn-send" onClick={send} disabled={!draft.trim()}>
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** One turn: a trigger header row that folds the turn's records. */
function TurnView({ turn }: { turn: TurnProjection }) {
  const [open, setOpen] = useState(turn.status === "running");
  const records = turn.records ?? [];
  const assistant = records.filter((r) => r.kind === "model.reply");
  const tools = records.filter((r) => r.kind?.startsWith("tool."));
  const approvals = records.filter((r) => r.kind?.startsWith("approval"));
  const status = turn.status ?? "unknown";

  return (
    <div className={`turn ${status}`}>
      <button className="turn-trigger" data-open={open} onClick={() => setOpen((v) => !v)}>
        <span className="turn-caret">▾</span>
        <span className="turn-status">{status}</span>
        <span className="turn-meta">
          {tools.length} tool{tools.length === 1 ? "" : "s"}
          {approvals.length > 0 && ` · ${approvals.length} approval`}
          {turn.at ? ` · ${new Date(turn.at).toLocaleTimeString()}` : ""}
        </span>
      </button>

      {open && (
        <div className="turn-body">
          {records.map((r, i) => (
            <RecordView key={i} record={r} />
          ))}
        </div>
      )}

      {!open && assistant.length > 0 && (
        <div className="turn-preview">
          {String(assistant[assistant.length - 1]?.data?.message ?? "").slice(0, 160)}
        </div>
      )}
    </div>
  );
}

function RecordView({ record }: { record: TurnRecord }) {
  const [open, setOpen] = useState(false);
  const message = String(record.data?.message ?? "");

  if (record.kind === "message.user") {
    return (
      <div className="user-row">
        <div className="user-bubble">{String(record.data?.text ?? "")}</div>
      </div>
    );
  }
  if (record.kind === "message.assistant") {
    const calls = (record.data?.toolCalls as unknown[]) ?? [];
    return (
      <div className="rec-assistant">
        {record.data?.text ? <p>{String(record.data.text)}</p> : null}
        {calls.length > 0 && (
          <div className="rec-calls">
            {calls.map((c, i) => (
              <span key={i} className="rec-call">
                {(c as { name?: string }).name}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (record.kind === "message.tool") {
    const text = String(record.data?.text ?? "");
    return (
      <div className="rec-tool">
        <button className="rec-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} tool result
        </button>
        {open && <pre className="rec-pre">{text}</pre>}
      </div>
    );
  }
  if (record.kind?.startsWith("approval")) {
    const outcome = String(record.data?.outcome ?? "asked");
    return (
      <div className={`rec-approval ${outcome}`}>
        {record.kind === "approval/asked"
          ? `approval requested · ${String(record.data?.tool ?? "")}`
          : `approval ${outcome}`}
      </div>
    );
  }

  return (
    <div className="rec-line">
      <span>{record.kind}</span>
      {message && <span>{message}</span>}
    </div>
  );
}
