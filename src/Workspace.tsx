import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Markdown } from "./Markdown";
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

  // Context meter pills (ContextMeter): turns·steps, tok·cache%, context%.
  const steps = turns.reduce(
    (n, t) => n + (t.kind === "turn" ? foldTurn(t.records ?? []).length : 0),
    0,
  );
  const charTok = (s: string) => Math.ceil(s.length / 4);
  const totalTok = turns.reduce((n, t) => {
    if (t.kind !== "turn") return n;
    for (const nd of foldTurn(t.records ?? [])) {
      if (nd.kind === "user" || nd.kind === "assistant") n += charTok(nd.text);
      if (nd.kind === "call")
        n += charTok(nd.arguments) + charTok(nd.text ?? "");
    }
    return n;
  }, 0);
  const ctxWindow = 128_000;
  const tokLabel =
    totalTok >= 1000 ? `${(totalTok / 1000).toFixed(1)}K` : String(totalTok);
  const cachePct = 0;
  const ctxPct = Math.min(100, Math.round((totalTok / ctxWindow) * 100));

  // Basename for the hero workspace chip (workspaceLabel in EmptyHero).
  const workspaceBasename = workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const currentModelName =
    models.find((m) => m.id === model)?.name || model || "No models";

  function cycleModel() {
    if (models.length < 2) return;
    const at = models.findIndex((m) => m.id === model);
    onModel(models[(at + 1) % models.length].id);
  }

  function pickWorkspace() {
    const next = window.prompt("Workspace directory", workspace);
    if (next === null) return;
    setWorkspace(next);
    localStorage.setItem(WORKSPACE_KEY, next);
  }

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
            <div className="hero-root">
              <div className="hero-stack">
                <div className="hero-headline">
                  <img src="/logos/entry.svg" alt="" className="hero-mark" />
                  <span className="hero-title-group">
                    <span>Into the Unknown</span>
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="chat-column">
              {turns.map((turn, ti) =>
                turn.kind === "turn" ? (
                  <TurnView key={ti} turn={turn} onBranch={setDraft} />
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
            <>
              <div className="composer">
                {/* Hero accessory: the workspace chip rides the card's accessory
                    hole before the first message (EmptyHero/HeroShell). */}
                {turns.length === 0 && !busy && (
                  <div className="composer-accessory">
                    <button className="chip-workspace" onClick={pickWorkspace} title="Choose workspace">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path
                          d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4Z"
                          stroke="currentColor"
                          strokeWidth="1.2"
                        />
                      </svg>
                      <span className="chip-workspace-label">{workspaceBasename || "Choose workspace"}</span>
                      <svg className="chip-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                )}
                <textarea
                  className="composer-input"
                  value={draft}
                  rows={1}
                  placeholder="Message or run a task, / commands, @ files or sessions"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={!workspace.trim()}
                />
                <div className="composer-bar">
                  <div className="composer-tools">
                    <button className="btn-add" aria-label="Add files or run commands" title="Add files or run commands">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                    <select
                      className="chip-access"
                      value={composerMode}
                      onChange={(e) => setComposerMode(e.target.value as "queue" | "steer")}
                      aria-label="Access mode"
                    >
                      <option value="queue">Workspace Write</option>
                      <option value="steer">Read Only</option>
                    </select>
                  </div>
                  <div className="composer-trailing">
                    <button
                      className="chip-model"
                      onClick={cycleModel}
                      aria-label={`Select model, current ${currentModelName}`}
                      title="Select model"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M2 8h12M8 2c-3.5 3.5-3.5 8.5 0 12M8 2c3.5 3.5 3.5 8.5 0 12" stroke="currentColor" strokeWidth="1" />
                      </svg>
                      <span className="chip-model-label">{currentModelName}</span>
                      <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {busy ? (
                      <button
                        className="btn-send stop"
                        onClick={() => interruptAgent(sessionId)}
                        aria-label="Stop generating"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        className="btn-send"
                        onClick={send}
                        disabled={!draft.trim()}
                        aria-label="Send message"
                      >
                        <SendArrow />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="composer-dock" hidden={turns.length === 0}>
                <button className="meter-pill" title="Turn and step counts">
                  {turns.length} turns {steps} steps
                </button>
                <button className="meter-pill" title="Token usage and cache hit rate">
                  {tokLabel} tok · Cache hit {cachePct}%
                </button>
                <button className="meter-pill" title="Context window usage">
                  {ctxPct}% of context used
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * A process node — the DSH projection fold, ported 1:1 from the record
 * contract the session log emits:
 *   message.user      {text}
 *   message.assistant {text, toolCalls:[{id,name,arguments}]}
 *   message.tool      {callId, text}
 *   approval/asked    {callId, tool, reason}
 *   approval/decided  {callId, outcome}
 * Stream frames (tool.started/tool.finished/model.reply/…) are `ignorable`
 * audit-only events: the live status renders them, the transcript does not.
 */
type Node =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; calls: { id: string; name: string; arguments: string }[] }
  | { kind: "call"; id: string; name: string; arguments: string; text?: string; failed?: boolean }
  | { kind: "approval"; callId: string; tool: string; reason: string; outcome?: string };

function foldTurn(records: TurnRecord[]): Node[] {
  const nodes: Node[] = [];
  const callIndex = new Map<string, number>();

  for (const r of records) {
    if (r.ignorable) continue; // stream-only frame
    const d = (r.data ?? {}) as Record<string, unknown>;
    switch (r.kind) {
      case "message.user":
        nodes.push({ kind: "user", text: String(d.text ?? "") });
        break;
      case "message.assistant": {
        const calls = ((d.toolCalls as unknown[]) ?? []).map((c) => {
          const call = c as { id?: string; name?: string; arguments?: unknown };
          return {
            id: String(call.id ?? ""),
            name: String(call.name ?? "tool"),
            arguments:
              typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments ?? {}),
          };
        });
        const text = String(d.text ?? "");
        if (text) nodes.push({ kind: "assistant", text, calls: [] });
        // Each call gets its own node; results attach to it by callId.
        for (const call of calls) {
          callIndex.set(call.id, nodes.length);
          nodes.push({ kind: "call", ...call });
        }
        break;
      }
      case "message.tool": {
        const id = String(d.callId ?? "");
        const text = String(d.text ?? "");
        const failed = text.startsWith("REFUSED:") || text.startsWith("APPROVAL_");
        const at = callIndex.get(id);
        if (at !== undefined) {
          nodes[at] = { ...(nodes[at] as Extract<Node, { kind: "call" }>), text, failed };
        } else {
          nodes.push({ kind: "call", id, name: "tool", arguments: "{}", text, failed });
        }
        break;
      }
      case "approval/asked":
        nodes.push({
          kind: "approval",
          callId: String(d.callId ?? ""),
          tool: String(d.tool ?? ""),
          reason: String(d.reason ?? ""),
        });
        break;
      case "approval/decided": {
        const id = String(d.callId ?? "");
        const at = nodes.findIndex((n) => n.kind === "approval" && callId(n) === id);
        if (at >= 0) {
          nodes[at] = { ...(nodes[at] as Extract<Node, { kind: "approval" }>), outcome: String(d.outcome ?? "") };
        }
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

function callId(n: Node): string {
  return n.kind === "approval" ? n.callId : "";
}

/** One turn: a TurnProcessNodeView trigger header row that folds the turn's records. */
function TurnView({ turn, onBranch }: { turn: TurnProjection; onBranch?: (text: string) => void }) {
  const [open, setOpen] = useState(turn.status === "running");
  const nodes = foldTurn(turn.records ?? []);
  const calls = nodes.filter((n) => n.kind === "call");
  const approvals = nodes.filter((n) => n.kind === "approval");
  const lastAssistant = [...nodes].reverse().find((n) => n.kind === "assistant");
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
          {calls.length} tool{calls.length === 1 ? "" : "s"}
          {approvals.length > 0 && ` · ${approvals.length} approval`}
          {turn.at ? ` · ${new Date(turn.at).toLocaleTimeString()}` : ""}
        </span>
      </button>

      {open && (
        <div className="turn-body">
          {nodes.map((n, i) => (
            <NodeView key={i} node={n} onBranch={onBranch} />
          ))}
        </div>
      )}

      {!open && lastAssistant?.kind === "assistant" && (
        <div className="turn-preview">
          <Markdown>{lastAssistant.text}</Markdown>
        </div>
      )}
    </div>
  );
}

/** Message footer (AssistantMarkdown action row): Copy · feedback · branch. */
function MessageFooter({ text, onBranch }: { text: string; onBranch?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  return (
    <div className="msg-footer">
      <button
        className="msg-action"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        className={`msg-action${vote === "up" ? " active" : ""}`}
        aria-label="Good response"
        onClick={() => setVote(vote === "up" ? null : "up")}
      >
        Good response
      </button>
      <button
        className={`msg-action${vote === "down" ? " active" : ""}`}
        aria-label="Bad response"
        onClick={() => setVote(vote === "down" ? null : "down")}
      >
        Bad response
      </button>
      <button
        className="msg-action"
        onClick={() => onBranch?.(text)}
      >
        Branch into a new conversation
      </button>
    </div>
  );
}

function NodeView({ node, onBranch }: { node: Node; onBranch?: (text: string) => void }) {
  const [open, setOpen] = useState(false);

  if (node.kind === "user") {
    return (
      <div className="user-row" data-part="turn-trigger">
        <div className="user-bubble">{node.text}</div>
      </div>
    );
  }
  if (node.kind === "assistant") {
    return (
      <div className="rec-assistant" data-part="response">
        <Markdown>{node.text}</Markdown>
        <MessageFooter text={node.text} onBranch={onBranch} />
      </div>
    );
  }
  if (node.kind === "call") {
    // DSH ioCard summary: first line of the result (or of the arguments when
    // the result has not settled yet).
    const summarySrc = node.text ?? node.arguments;
    const summary = summarySrc.split("\n")[0];
    return (
      <div className="rec-calls">
        <ToolRow
          name={node.name}
          summary={summary}
          error={node.failed}
          expandable={node.text !== undefined}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          body={open ? node.text : undefined}
        />
      </div>
    );
  }
  // approval node: asked → decided pair, folded into one row
  return (
    <div className={`rec-approval ${node.outcome ?? "asked"}`}>
      {node.outcome
        ? `approval ${node.outcome} · ${node.tool}`
        : `approval requested · ${node.tool}`}
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
