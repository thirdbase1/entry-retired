import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  answerApproval,
  interruptAgent,
  runAgent,
  sessionEvents,
  type ApprovalRequest,
  type TurnRecord,
  type TurnProjection,
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

const SESSION_KEY = "entry-desktop-session-id";
const WORKSPACE_KEY = "entry-desktop-workspace";

type StreamLine = { stream: string; text: string };

/**
 * The conversation surface: session sidebar, chat transcript with foldable
 * turns, live execution stream, approval takeover in the composer, and jobs.
 */
export function Workspace({ username, plan, balance, model, models, onModel, onSignOut }: Props) {
  const [workspace, setWorkspace] = useState(
    () => localStorage.getItem(WORKSPACE_KEY) ?? "",
  );
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
  const busyRef = useRef(false);

  busyRef.current = busy;

  // Live agent events → execution stream.
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<{ kind: string; message: string }>("entry://agent-event", (e) => {
      setLines((prev) => [
        ...prev.slice(-300),
        { stream: e.payload.kind, text: e.payload.message },
      ]);
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
    listen<ApprovalRequest>("entry://approval-request", (e) => {
      setPending(e.payload);
    }).then((un) => {
      off = un;
    });
    return () => off?.();
  }, []);

  // Reload the durable projection whenever a turn settles.
  useEffect(() => {
    if (!workspace) return;
    sessionEvents(workspace, sessionId)
      .then(setTurns)
      .catch(() => setTurns([]));
  }, [workspace, sessionId, busy]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, lines]);

  async function send() {
    const text = draft.trim();
    if (!text || !workspace.trim()) return;
    if (busy && composerMode === "queue") {
      setNotice("A turn is already running — switch the composer to steer to interrupt it.");
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
      if (pending) {
        decide("allow");
      } else {
        send();
      }
    }
  }

  function newSession() {
    const fresh = `session-${Date.now()}`;
    localStorage.setItem(SESSION_KEY, fresh);
    setTurns([]);
    setLines([]);
    window.location.reload();
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="side-head">
          <img src="/logos/entry.svg" alt="" className="side-logo" />
          <span>Entry</span>
        </div>
        <button className="side-new" onClick={newSession}>
          + New session
        </button>
        <div className="side-label">Session</div>
        <div className="side-item active">{sessionId.replace("session-", "#")}</div>
        <div className="side-label">Workspace</div>
        <input
          className="side-input"
          value={workspace}
          onChange={(e) => {
            setWorkspace(e.target.value);
            localStorage.setItem(WORKSPACE_KEY, e.target.value);
          }}
          placeholder="C:\\path\\to\\repo"
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
          <span className={`run-state${busy ? " live" : ""}`}>
            {busy ? "running" : "ready"}
          </span>
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
            {lines.filter((l) => l.stream.startsWith("tool.")).length === 0 ? (
              <span className="jobs-empty">No background work yet.</span>
            ) : (
              lines
                .filter((l) => l.stream.startsWith("tool."))
                .slice(-8)
                .map((l, i) => (
                  <div key={i} className="jobs-row">
                    <span className="jobs-kind">{l.stream}</span>
                    <span className="jobs-text">{l.text.slice(0, 90)}</span>
                  </div>
                ))
            )}
          </div>
        )}

        <div className="transcript" ref={scrollRef}>
          {turns.length === 0 && !busy && (
            <div className="empty-state">
              <h2>What should Entry work on?</h2>
              <p>
                Point the workspace at a repository, then describe the task.
                Entry works natively on this machine and asks before running
                anything dangerous.
              </p>
            </div>
          )}

          {turns.map((turn, ti) =>
            turn.kind === "turn" ? (
              <TurnView key={ti} turn={turn} />
            ) : (
              <div key={ti} className="loose-record">
                {String((turn as unknown as Record<string, unknown>).kind ?? "")}
              </div>
            ),
          )}

          {busy && (
            <div className="live-turn">
              <div className="live-head">
                <span className="dot" /> Working
              </div>
              {lines.slice(-14).map((l, i) => (
                <div key={i} className={`live-line ${l.stream}`}>
                  <span className="live-kind">{l.stream}</span>
                  <span className="live-text">{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {notice && <div className="notice">{notice}</div>}

        <div className={`composer${pending ? " takeover" : ""}`}>
          {pending ? (
            <div className="approval">
              <div className="approval-title">
                Approve <code>{pending.toolName}</code>?
              </div>
              <div className="approval-reason">{pending.reason}</div>
              <div className="approval-actions">
                <button className="btn-allow" onClick={() => decide("allow")}>
                  Allow once
                </button>
                <button className="btn-reject" onClick={() => decide("reject")}>
                  Reject
                </button>
                <span className="approval-hint">
                  Enter = allow · Esc = reject · no response in 2 min denies
                </span>
              </div>
            </div>
          ) : (
            <>
              <textarea
                className="composer-input"
                value={draft}
                rows={2}
                placeholder="Describe what you want Entry to do…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={!workspace.trim()}
              />
              <div className="composer-bar">
                <label className="composer-mode">
                  Enter while busy:
                  <select
                    value={composerMode}
                    onChange={(e) =>
                      setComposerMode(e.target.value as "queue" | "steer")
                    }
                  >
                    <option value="queue">queue</option>
                    <option value="steer">steer</option>
                  </select>
                </label>
                <button className="btn-send" onClick={send} disabled={!draft.trim()}>
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** One turn: collapsible group of records with a 3-level fold. */
function TurnView({ turn }: { turn: TurnProjection }) {
  const [open, setOpen] = useState(turn.status === "running");
  const records = turn.records ?? [];
  const assistant = records.filter((r) => r.kind === "model.reply");
  const tools = records.filter((r) => r.kind?.startsWith("tool."));
  const approvals = records.filter((r) => r.kind?.startsWith("approval"));

  const status = turn.status ?? "unknown";

  return (
    <div className={`turn ${status}`}>
      <button className="turn-head" onClick={() => setOpen((v) => !v)}>
        <span className={`turn-caret${open ? " open" : ""}`}>›</span>
        <span className="turn-status">{status}</span>
        <span className="turn-meta">
          {tools.length} tool{tools.length === 1 ? "" : "s"}
          {approvals.length > 0 && ` · ${approvals.length} approval`}
        </span>
      </button>

      {open && (
        <div className="turn-body">
          {records
            .filter((r) => r.ignorable === false)
            .map((r, i) => (
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
    return <div className="rec-user">{String(record.data?.text ?? "")}</div>;
  }
  if (record.kind === "message.assistant") {
    const calls = (record.data?.toolCalls as unknown[]) ?? [];
    return (
      <div className="rec-assistant">
        {record.data?.text ? <p>{String(record.data.text)}</p> : null}
        {calls.length > 0 && (
          <div className="rec-calls">
            {calls.map((c, i) => {
              const call = c as { name?: string };
              return (
                <span key={i} className="rec-call">
                  {call.name}
                </span>
              );
            })}
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
      <span className="rec-kind">{record.kind}</span>
      {message && <span className="rec-msg">{message}</span>}
    </div>
  );
}
