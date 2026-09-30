//! Approval service — the DSH-grade gate for anything the agent wants to do
//! that needs the user's say-so.
//!
//! Ported laws (from the deep-dive):
//! - The outcome union is CLOSED: `allowed-once | rejected | cancelled |
//!   unavailable`. There is no "always allow" — DSH doesn't have it either.
//! - Every request/decision pair is audited in the session log as
//!   `approval/asked` + `approval/decided`. Asking outside a turn throws.
//! - Fail-closed: no answerer, timeout, or malformed answer ⇒ `unavailable`,
//!   which the tool pipeline treats as a denial.
//! - `Ask | Never` policy is enforced INSIDE the service, before dispatch —
//!   a listener can never flip a denial.

use crate::session_log::SessionLog;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    AllowedOnce,
    Rejected,
    Cancelled,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalPolicy {
    /// Ask the user for every request that needs approval.
    Ask,
    /// Never ask: requests that would need approval are denied in-service.
    Never,
}

/// What the UI receives. Tool arguments ride along by `call_id` — the UI
/// attaches details from the conversation record, the request itself stays
/// small and stable.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub call_id: String,
    pub tool_name: String,
    pub reason: String,
    pub created_at: u64,
}

/// One pending prompt in the per-session queue.
struct Pending {
    request: ApprovalRequest,
    reply: mpsc::SyncSender<ApprovalOutcome>,
}

pub struct ApprovalService {
    policy: Mutex<ApprovalPolicy>,
    ui_notify: Mutex<Option<Box<dyn Fn(&ApprovalRequest) + Send + Sync>>>,
    pending: Arc<Mutex<Vec<Pending>>>,
    /// Bumped whenever a new request lands; the UI watches this via an event.
    turn_open: Mutex<bool>,
}

const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

impl ApprovalService {
    pub fn new() -> Self {
        Self {
            policy: Mutex::new(ApprovalPolicy::Ask),
            ui_notify: Mutex::new(None),
            pending: Arc::new(Mutex::new(Vec::new())),
            turn_open: Mutex::new(false),
        }
    }

    pub fn set_policy(&self, policy: ApprovalPolicy) {
        *self.policy.lock().unwrap() = policy;
    }

    pub fn policy(&self) -> ApprovalPolicy {
        *self.policy.lock().unwrap()
    }

    pub fn open_turn(&self) {
        *self.turn_open.lock().unwrap() = true;
    }

    pub fn close_turn(&self) {
        *self.turn_open.lock().unwrap() = false;
    }

    /// Ask the user. Returns ONLY a closed-outcome union; every failure mode
    /// collapses into `Unavailable` (fail-closed), never into allow.
    pub fn request(
        &self,
        log: &mut SessionLog,
        call_id: &str,
        tool_name: &str,
        reason: &str,
    ) -> ApprovalOutcome {
        // Law: asking outside a turn is a programming error — deny instead.
        if !*self.turn_open.lock().unwrap() {
            return ApprovalOutcome::Unavailable;
        }
        // Policy gate lives HERE, before any dispatch.
        if self.policy() == ApprovalPolicy::Never {
            return ApprovalOutcome::Rejected;
        }

        let request = ApprovalRequest {
            call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            reason: reason.to_string(),
            created_at: crate::session_log::now_ms(),
        };

        // Audit: asked.
        let _ = log.append(
            "approval/asked",
            json!({"callId": call_id, "tool": tool_name, "reason": reason}),
        );

        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut queue = self.pending.lock().unwrap();
            queue.push(Pending {
                request: request.clone(),
                reply: tx,
            });
        }

        // Surface to the UI through the host-installed callback.
        if let Some(notify) = self.ui_notify.lock().unwrap().as_ref() {
            notify(&request);
        }

        let outcome = match rx.recv_timeout(ANSWER_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(_) => ApprovalOutcome::Unavailable, // timeout ⇒ fail closed
        };

        // Audit: decided (always, even for unavailable).
        let _ = log.append(
            "approval/decided",
            json!({"callId": call_id, "outcome": outcome}),
        );

        outcome
    }

    /// UI answers a pending request by call_id. Unknown ids are ignored — the
    /// timeout will fail the request closed.
    pub fn answer(&self, call_id: &str, outcome: ApprovalOutcome) -> bool {
        let mut queue = self.pending.lock().unwrap();
        if let Some(pos) = queue.iter().position(|p| p.request.call_id == call_id) {
            let pending = queue.remove(pos);
            let _ = pending.reply.send(outcome);
            true
        } else {
            false
        }
    }

    /// Drain everything pending — used on turn end / cancellation. Every
    /// orphaned request fails closed as `cancelled`.
    pub fn cancel_all(&self) {
        let mut queue = self.pending.lock().unwrap();
        for pending in queue.drain(..) {
            let _ = pending.reply.send(ApprovalOutcome::Cancelled);
        }
    }

    /// Snapshot of what's waiting, for the UI to render on demand.
    pub fn pending_snapshot(&self) -> Vec<ApprovalRequest> {
        self.pending
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.request.clone())
            .collect()
    }

    /// The host installs the notification callback (e.g. emit a Tauri event),
    /// keeping this module free of Tauri types.
    pub fn set_ui_notify(&self, notify: impl Fn(&ApprovalRequest) + Send + Sync + 'static) {
        *self.ui_notify.lock().unwrap() = Some(Box::new(notify));
    }
}

impl Default for ApprovalService {
    fn default() -> Self {
        Self::new()
    }
}

/// Map an outcome onto the PreToolDecision the tool pipeline consumes.
/// `Unavailable` denies (fail-closed) — never retries, never falls through.
pub fn gate(outcome: ApprovalOutcome) -> Result<(), String> {
    match outcome {
        ApprovalOutcome::AllowedOnce => Ok(()),
        ApprovalOutcome::Rejected => Err("User rejected this command.".into()),
        ApprovalOutcome::Cancelled => Err("Approval was cancelled.".into()),
        ApprovalOutcome::Unavailable => {
            Err("No one could answer the approval request in time — denied (fail closed).".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_log::SessionLog;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "entry-approval-test-{}-{}",
            std::process::id(),
            crate::session_log::now_ms()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn ask_outside_turn_fails_closed() {
        let dir = temp_dir();
        let svc = ApprovalService::new();
        let mut log = SessionLog::open(&dir, "s").unwrap();
        assert_eq!(
            svc.request(&mut log, "c1", "bash", "test"),
            ApprovalOutcome::Unavailable
        );
    }

    #[test]
    fn never_policy_denies_without_asking() {
        let dir = temp_dir();
        let svc = ApprovalService::new();
        svc.set_policy(ApprovalPolicy::Never);
        svc.open_turn();
        let mut log = SessionLog::open(&dir, "s").unwrap();
        assert_eq!(
            svc.request(&mut log, "c1", "bash", "test"),
            ApprovalOutcome::Rejected
        );
        assert!(log
            .replay()
            .unwrap()
            .iter()
            .all(|e| e.kind != "approval/asked"));
    }

    #[test]
    fn answer_flows_and_is_audited() {
        let dir = temp_dir();
        let svc = Arc::new(ApprovalService::new());
        svc.set_ui_notify(|_r| {});
        svc.open_turn();
        let mut log = SessionLog::open(&dir, "s").unwrap();

        let answerer = svc.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            answerer.answer("c1", ApprovalOutcome::Rejected);
        });
        let outcome = svc.request(&mut log, "c1", "bash", "rm -rf");
        t.join().unwrap();
        assert_eq!(outcome, ApprovalOutcome::Rejected);

        let kinds: Vec<String> = log.replay().unwrap().into_iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&"approval/asked".to_string()));
        assert!(kinds.contains(&"approval/decided".to_string()));
    }

    #[test]
    fn cancel_all_fails_pending_closed() {
        let dir = temp_dir();
        let svc = Arc::new(ApprovalService::new());
        svc.set_ui_notify(|_r| {});
        svc.open_turn();
        let mut log = SessionLog::open(&dir, "s").unwrap();

        let answerer = svc.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            answerer.cancel_all();
        });
        let outcome = svc.request(&mut log, "c1", "bash", "x");
        t.join().unwrap();
        assert_eq!(outcome, ApprovalOutcome::Cancelled);
    }
}
