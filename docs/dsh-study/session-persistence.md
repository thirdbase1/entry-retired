# dsh Session Persistence -> Entry Desktop Event Log

Source: packages/core/session, session/*, compaction/*, docs/subsystems/{session,persistence,compaction}

## Format
- Append-only per-session JSONL; header line first (never in derive/render):
  {format_version, session_id, created_at, cwd, parent_session?}
- Envelope: {type, seq, time, data, ignorable?}; contiguous monotonic seq;
  serde tagged enum = narrowing by tag
- ignorable:true = forward compat (purely informational); unknown NON-ignorable
  type => REFUSE to open; adding ignorable type does NOT bump version
- SESSION_FORMAT_VERSION single monotonic int; bump only structural breaks;
  adjacent-only non-destructive migrations (session.v2.jsonl beside v1)
- Surface events (model history): user/assistant/system messages, tool/result;
  surfaceOp: append | {replace, startSeq, endSeq} citing shadowed seqs
- MODEL-VISIBLE <=> LOGGED: deriveMessages() replays log applying surface ops;
  transcript rendered from log, never UI state
- Compaction: log-only bracket compaction/start|summary|end; summary rides
  surface as user/message with replace op; human transcript survives via
  append-origin filtering; replay warm prefix byte-for-byte for summarization
- Crash recovery: never truncate mid-turn; synthetic closers
  (tool ends, step/end, turn/end{interrupted}); torn tail discarded+rewritten
- Schema fingerprint (JSON Schema + SHA-256) CI-checked to catch payload drift

## Entry Desktop actions
1. session_log.rs: JSONL append-only, file lock single writer, header + envelope
2. Core events: turn/start|end, step/start|end, user/message, assistant/message
   (embedded final stream + usage), tool/call, tool/result
3. Streaming chunks = transient only, never persisted
4. Compaction bracket + replace surface op (Phase 5+)
5. Dev index (titles, list) in separate cache keyed by stat revision
