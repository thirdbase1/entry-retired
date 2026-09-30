//! Session event log — the append-only record that *is* the session.
//!
//! Ported contract (from the dsh study): an envelope is
//! `{type, seq, time, data, ignorable?}` appended as one JSONL line. The law is
//! **model-visible ⟺ logged**: if the model saw it, it is in this file; if it is
//! not in this file, the model never saw it. Replay reads the same file the
//! writer wrote, so recovery is exact instead of reconstructed.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One envelope in the log. `seq` is monotonic per session and `time` is a
/// unix-epoch millisecond stamp, which keeps ordering total even when two
/// events land in the same millisecond.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub seq: u64,
    pub time: u64,
    pub data: Value,
    /// Marks an event the model may skip: it is context, not instruction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignorable: Option<bool>,
}

impl Envelope {
    pub fn data_str(&self, key: &str) -> Option<&str> {
        self.data.get(key).and_then(Value::as_str)
    }
}

/// A single session's log. Appends are the only mutation; there is no update or
/// delete path, which is what makes replay trustworthy.
pub struct SessionLog {
    path: PathBuf,
    seq: u64,
}

impl SessionLog {
    /// Open (or create) the log for a session inside a workspace.
    pub fn open(workspace: &Path, session_id: &str) -> Result<Self, String> {
        let dir = workspace.join(".entry").join("sessions");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create session dir: {e}"))?;
        let path = dir.join(format!("{}.jsonl", sanitize(session_id)));
        let seq = Self::last_seq(&path)?;
        Ok(Self { path, seq })
    }

    fn last_seq(path: &Path) -> Result<u64, String> {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.to_string()),
        };
        // Tolerate a torn final line: only whole, parseable envelopes count.
        let seq = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Envelope>(line).ok())
            .map(|e| e.seq)
            .max()
            .unwrap_or(0);
        Ok(seq)
    }

    pub fn append(&mut self, kind: &str, data: Value) -> Result<Envelope, String> {
        self.seq += 1;
        let envelope = Envelope {
            kind: kind.to_string(),
            seq: self.seq,
            time: now_ms(),
            data,
            ignorable: None,
        };
        self.write(&envelope)?;
        Ok(envelope)
    }

    /// Append an event flagged as skippable context.
    pub fn append_ignorable(&mut self, kind: &str, data: Value) -> Result<Envelope, String> {
        let mut envelope = self.append(kind, data)?;
        envelope.ignorable = Some(true);
        Ok(envelope)
    }

    fn write(&self, envelope: &Envelope) -> Result<(), String> {
        let line = serde_json::to_string(envelope).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("Cannot open session log: {e}"))?;
        writeln!(file, "{line}").map_err(|e| format!("Cannot append to session log: {e}"))
    }

    /// Read every envelope in order (replay).
    pub fn replay(&self) -> Result<Vec<Envelope>, String> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let mut events: Vec<Envelope> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Envelope>(line).ok())
            .collect();
        events.sort_by_key(|e| e.seq);
        Ok(events)
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Rebuild the model-visible conversation from the log. Only events the
    /// model actually saw are replayed into messages — the tail of an
    /// interrupted turn (assistant reply with open tool calls) is closed so the
    /// conversation stays valid.
    pub fn rebuild_messages(&self) -> Result<Vec<crate::network::ChatMessage>, String> {
        use crate::network::ChatMessage;
        let mut messages: Vec<ChatMessage> = Vec::new();
        let mut open_calls: Vec<String> = Vec::new();

        for event in self.replay()? {
            match event.kind.as_str() {
                "message.user" => {
                    if let Some(text) = event.data_str("text") {
                        messages.push(ChatMessage {
                            role: "user".into(),
                            content: Some(text.to_string()),
                            tool_calls: None,
                            tool_call_id: None,
                        });
                    }
                }
                "message.assistant" => {
                    let text = event.data_str("text").map(str::to_string);
                    let calls = event
                        .data
                        .get("toolCalls")
                        .and_then(Value::as_array)
                        .map(|list| {
                            list.iter()
                                .filter_map(|c| {
                                    Some(crate::network::ToolCall {
                                        id: c.get("id")?.as_str()?.to_string(),
                                        kind: "function".into(),
                                        function: crate::network::FunctionCall {
                                            name: c.get("name")?.as_str()?.to_string(),
                                            arguments: c
                                                .get("arguments")
                                                .and_then(Value::as_str)
                                                .unwrap_or("{}")
                                                .to_string(),
                                        },
                                    })
                                })
                                .collect::<Vec<_>>()
                        });
                    open_calls = calls
                        .as_ref()
                        .map(|list| list.iter().map(|c| c.id.clone()).collect())
                        .unwrap_or_default();
                    messages.push(ChatMessage {
                        role: "assistant".into(),
                        content: text,
                        tool_calls: calls,
                        tool_call_id: None,
                    });
                }
                "message.tool" => {
                    if let Some(call_id) = event.data_str("callId") {
                        let text = event.data_str("text").unwrap_or("").to_string();
                        messages.push(ChatMessage {
                            role: "tool".into(),
                            content: Some(text),
                            tool_calls: None,
                            tool_call_id: Some(call_id.to_string()),
                        });
                        open_calls.retain(|id| id != call_id);
                    }
                }
                _ => {}
            }
        }

        // Repair: an interrupted turn left tool calls with no results. Answer
        // them so the next request is valid, and say so honestly.
        for call_id in open_calls {
            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(
                    "[interrupted] This tool call never completed — the turn was \
                     interrupted before a result was recorded."
                        .into(),
                ),
                tool_calls: None,
                tool_call_id: Some(call_id),
            });
        }

        Ok(messages)
    }

    /// Fold the log into UI records: turns → groups → tool calls.
    pub fn project(&self) -> Result<Vec<Value>, String> {
        let mut out: Vec<Value> = Vec::new();
        let mut index: BTreeMap<String, usize> = BTreeMap::new();

        for event in self.replay()? {
            match event.kind.as_str() {
                "turn.started" => {
                    out.push(serde_json::json!({
                        "kind": "turn",
                        "id": event.data_str("turnId").unwrap_or_default(),
                        "status": "running",
                        "at": event.time,
                        "records": [],
                    }));
                    if let Some(id) = event.data_str("turnId") {
                        index.insert(id.to_string(), out.len() - 1);
                    }
                }
                "turn.completed" | "turn.interrupted" => {
                    if let Some(id) = event.data_str("turnId") {
                        if let Some(&at) = index.get(id) {
                            out[at]["status"] = Value::String(if event.kind == "turn.completed" {
                                "completed".into()
                            } else {
                                "interrupted".into()
                            });
                        }
                    }
                }
                _ => {
                    let record = serde_json::json!({
                        "kind": event.kind,
                        "seq": event.seq,
                        "at": event.time,
                        "data": event.data,
                        "ignorable": event.ignorable.unwrap_or(false),
                    });
                    match out.last_mut() {
                        Some(turn) if turn["status"] == "running" => {
                            turn["records"].as_array_mut().map(|r| r.push(record));
                        }
                        _ => out.push(record),
                    }
                }
            }
        }
        Ok(out)
    }
}

pub fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_session(name: &str) -> (PathBuf, SessionLog) {
        let dir = std::env::temp_dir().join(format!("entry-log-test-{name}-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = SessionLog::open(&dir, "s1").unwrap();
        (dir, log)
    }

    #[test]
    fn seq_is_monotonic_across_reopen() {
        let (dir, mut log) = temp_session("mono");
        log.append("message.user", serde_json::json!({"text": "hi"}))
            .unwrap();
        log.append("message.assistant", serde_json::json!({"text": "yo"}))
            .unwrap();
        let reopened = SessionLog::open(&dir, "s1").unwrap();
        assert_eq!(reopened.seq(), 2);
    }

    #[test]
    fn replay_keeps_every_event_in_order() {
        let (_dir, mut log) = temp_session("replay");
        for i in 0..5 {
            log.append("x", serde_json::json!({"i": i})).unwrap();
        }
        let events = log.replay().unwrap();
        assert_eq!(events.len(), 5);
        assert_eq!(events[4].seq, 5);
    }

    #[test]
    fn interrupted_turn_is_repaired_on_rebuild() {
        let (_dir, mut log) = temp_session("repair");
        log.append("message.user", serde_json::json!({"text": "do it"}))
            .unwrap();
        log.append(
            "message.assistant",
            serde_json::json!({"text": null, "toolCalls": [{"id": "c1", "name": "bash", "arguments": "{}"}]}),
        )
        .unwrap();
        let messages = log.rebuild_messages().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2].role, "tool");
        assert_eq!(messages[2].tool_call_id.as_deref(), Some("c1"));
    }

    #[test]
    fn torn_final_line_is_ignored() {
        let (dir, mut log) = temp_session("torn");
        log.append("message.user", serde_json::json!({"text": "a"}))
            .unwrap();
        let path = dir.join(".entry").join("sessions").join("s1.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{\"type\":\"message.user\",\"seq\":2").unwrap();
        assert_eq!(log.replay().unwrap().len(), 1);
        assert_eq!(SessionLog::open(&dir, "s1").unwrap().seq(), 1);
    }
}
