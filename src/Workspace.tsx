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

const SESSION_KEY = "entry-session-id";
const WORKSPACE_KEY = "entry-workspace";

type StreamLine = { stream: string; text: string };

/** The 34px blue-circle send arrow (figma IconButton 34:10465). */
function SendArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M12 5l-6 6M12 5l6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The conversation surface, distilled 1:1 from the DeepSeek harness client:
 * AppFrame (sidebar column 248px + center column), ConversationRoot header
 * (76px, 0.5px l3 rule, dsh .select chips), ChatView column at
 * --dsh-chat-content-width with 6/12/16 flow gaps, MessageItem right-aligned
 * user bubble (radius-xl, specific-bubble fill), ui-tool DisclosureRow tool
 * rows (16px leading, 13/24 title, 2px dot, ioCard body), the running
 * status with the deep-diving color and divider, and the InputBar composer
 * card (panel radius 28, input-major fill, elevation-soft, 34px info-fill
 * send circle). Approval replaces the composer (ApprovalPanel takeover).
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

  // Esc rejects a pending approval at the document level — the approval card
  // replaces the textarea, so its keydown handler is not mounted to catch it.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        decideRef.current("reject");
      } else if (e.key === "Enter") {
        e.preventDefault();
        decideRef.current("allow");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

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
    if (!pendingRef.current) return;
    const callId = pendingRef.current.callId;
    setPending(null);
    await answerApproval(sessionId, callId, decision);
  }

  // Always-current bindings for the document-level key handlers.
  const decideRef = useRef(decide);
  const pendingRef = useRef<ApprovalRequest | null>(null);
  decideRef.current = decide;
  pendingRef.current = pending;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter is a newline. IME composition is respected.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
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
      <aside className="sidebarCol">
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

      <main className="centerCol main">
        <header className="chat-head">
          <span className={`run-state${busy ? " live" : ""}`}>{busy ? "running" : "ready"}</span>
          <div style={{ display: "flex", alignItems: "center" }}>
            <button className="head-btn" onClick={() => setShowJobs((v) => !v)}>
              Jobs
            </button>
            {busy && (
              <button className="head-btn danger" onClick={() => interruptAgent(sessionId)}>
                Stop
              </button>
            )}
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
          </div>
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
          {turns.length === 0 && !busy ? (
            <div className="empty-state">
              <div className="empty-stack">
                <div className="empty-headline">What should Entry work on?</div>
                <p className="empty-sub">
                  Point the workspace at a repository, then describe the task. Entry works
                  natively on this machine and asks before running anything dangerous.
                </p>
              </div>
            </div>
          ) : (
            <div className="chat-column">
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
                    <span className="running-icon" />
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
          )}
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
                placeholder={
                  workspace.trim() ? "Describe what you want Entry to do…" : "Choose a workspace first…"
                }
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={!workspace.trim()}
              />
              <div className="composer-bar">
                <div className="composer-mode">
                  <select
                    value={composerMode}
                    onChange={(e) => setComposerMode(e.target.value as "queue" | "steer")}
                    aria-label="Enter while busy"
                  >
                    <option value="queue">queue</option>
                    <option value="steer">steer</option>
                  </select>
                </div>
                <button className="btn-send" onClick={send} disabled={!draft.trim()} aria-label="Send">
                  <SendArrow />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** One turn: a TurnProcessNodeView trigger header row that folds the turn's records. */
function TurnView({ turn }: { turn: TurnProjection }) {
  const [open, setOpen] = useState(turn.status === "running");
  const records = turn.records ?? [];
  const assistant = records.filter((r) => r.kind === "model.reply");
  const tools = records.filter((r) => r.kind?.startsWith("tool."));
  const approvals = records.filter((r) => r.kind?.startsWith("approval"));
  const status = turn.status ?? "unknown";

  return (
    <div className={`turn ${status}`} data-part="turn-process">
      <button className="turn-trigger" data-open={open} onClick={() => setOpen((v) => !v)}>
        <svg className="turn-caret" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
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
      <div className="user-row" data-part="turn-trigger">
        <div className="user-bubble">{String(record.data?.text ?? "")}</div>
      </div>
    );
  }
  if (record.kind === "message.assistant") {
    const calls = (record.data?.toolCalls as unknown[]) ?? [];
    return (
      <div className="rec-assistant" data-part="response">
        {record.data?.text ? <p>{String(record.data.text)}</p> : null}
        {calls.length > 0 && (
          <div className="rec-calls">
            {calls.map((c, i) => (
              <ToolRow key={i} name={(c as { name?: string }).name ?? "tool"} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (record.kind === "message.tool") {
    const text = String(record.data?.text ?? "");
    const isErr = text.startsWith("REFUSED") || text.startsWith("APPROVAL_REQUIRED");
    return (
      <div className="rec-calls">
        <ToolRow
          name="tool result"
          summary={text.split("\n")[0]}
          error={isErr}
          expandable
          open={open}
          onToggle={() => setOpen((v) => !v)}
          body={open ? text : undefined}
        />
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

/**
 * A ui-tool DisclosureRow tool row: 16px leading glyph box, 13/24 title,
 * 2px dot separator, truncated 13/24 summary, optional expandable ioCard.
 */
function ToolRow({
  name,
  summary,
  error,
  expandable,
  open,
  onToggle,
  body,
}: {
  name: string;
  summary?: string;
  error?: boolean;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  body?: string;
}) {
  const row = (
    <div
      className="tool-row"
      data-expandable={expandable ? "true" : undefined}
      data-open={open ? "true" : undefined}
      onClick={expandable ? onToggle : undefined}
    >
      <span className="tool-leading">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M9.5 1.5H5A1.5 1.5 0 0 0 3.5 3v10A1.5 1.5 0 0 0 5 14.5h6a1.5 1.5 0 0 0 1.5-1.5V4.5L9.5 1.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      </span>
      <span className="tool-title">{name}</span>
      {summary !== undefined && (
        <>
          <span className="tool-sep" />
          <span className="tool-summary" data-error={error ? "true" : undefined}>
            {summary}
          </span>
        </>
      )}
      {expandable && (
        <svg className="tool-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );

  if (!expandable) return <div>{row}</div>;
  return (
    <div>
      {row}
      {open && body !== undefined && (
        <div className="tool-body">
          <div className="tool-io">
            <span className="tool-io-label">OUT</span>
            <span className="tool-io-text" data-error={error ? "true" : undefined}>
              {body}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
