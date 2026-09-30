//! JobRegistry — background jobs with an output ring, ported from the DSH
//! deep-dive contracts:
//! - ids are `<kind>-N`; every call is fenced by owner session
//! - preflight-before-run, no-fail-after-commit
//! - `JobOutcome.result` is handed out exactly once
//! - the event stream carries payload-free `output` notifications; readers
//!   pull bytes from the ring by absolute offset
//! - jobs are process-local by design: nothing here persists across restarts

use crate::session_log::now_ms;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub const RING_LIVE_BYTES: usize = 256 * 1024;
const TAIL_SAMPLE: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum JobState {
    Running,
    Completed { exit_code: Option<i32> },
    Failed { reason: String },
    Killed { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProjection {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub state: JobState,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    /// Absolute byte offset of the ring's oldest retained byte.
    pub ring_head_offset: u64,
    /// Total bytes ever written.
    pub ring_total_bytes: u64,
}

struct Job {
    projection: JobProjection,
    ring: VecDeque<u8>,
    head_offset: u64,
    total_written: u64,
    result: Option<String>,
    result_taken: bool,
    child_cancel: Arc<Mutex<bool>>,
}

pub struct JobRegistry {
    jobs: Mutex<Vec<Arc<Mutex<Job>>>>,
    next_id: Mutex<u64>,
    /// Called when a job's observable state changes (payload-free notice).
    on_change: Mutex<Option<Box<dyn Fn(&JobProjection) + Send + Sync>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            on_change: Mutex::new(None),
        }
    }

    pub fn set_on_change(&self, f: impl Fn(&JobProjection) + Send + Sync + 'static) {
        *self.on_change.lock().unwrap() = Some(Box::new(f));
    }

    /// Admit a job. Preflight (the `title` and session fencing inputs) happens
    /// BEFORE the run commits — once admitted the registry owns it.
    pub fn admit(
        &self,
        kind: &str,
        session_id: &str,
        title: &str,
        cancel_flag: Arc<Mutex<bool>>,
    ) -> String {
        let n = {
            let mut next = self.next_id.lock().unwrap();
            let n = *next;
            *next += 1;
            n
        };
        let id = format!("{kind}-{n}");
        let job = Arc::new(Mutex::new(Job {
            projection: JobProjection {
                id: id.clone(),
                session_id: session_id.to_string(),
                title: title.to_string(),
                state: JobState::Running,
                started_at: now_ms(),
                ended_at: None,
                ring_head_offset: 0,
                ring_total_bytes: 0,
            },
            ring: VecDeque::new(),
            head_offset: 0,
            total_written: 0,
            result: None,
            result_taken: false,
            child_cancel: cancel_flag,
        }));
        self.jobs.lock().unwrap().push(job.clone());
        self.notify(&job);
        id
    }

    fn job(&self, session_id: &str, id: &str) -> Result<Arc<Mutex<Job>>, String> {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .find(|j| {
                let j = j.lock().unwrap();
                j.projection.id == id && j.projection.session_id == session_id
            })
            .cloned()
            .ok_or_else(|| format!("No job {id} in this session"))
    }

    /// Append output bytes. The ring keeps the newest RING_LIVE_BYTES; older
    /// bytes are evicted (head advances). Absolute offsets never shift.
    pub fn write_output(&self, session_id: &str, id: &str, bytes: &[u8]) -> Result<(), String> {
        let job = self.job(session_id, id)?;
        let mut job = job.lock().unwrap();
        for &b in bytes {
            job.ring.push_back(b);
            job.total_written += 1;
        }
        while job.ring.len() > RING_LIVE_BYTES {
            job.ring.pop_front();
            job.head_offset += 1;
        }
        job.projection.ring_head_offset = job.head_offset;
        job.projection.ring_total_bytes = job.total_written;
        Ok(())
    }

    /// Read a window of the ring by absolute offset (lossy UTF-8). Returns the
    /// text plus the offset to resume from.
    pub fn read_output(
        &self,
        session_id: &str,
        id: &str,
        from_offset: u64,
    ) -> Result<(String, u64), String> {
        let job = self.job(session_id, id)?;
        let job = job.lock().unwrap();
        let head = job.head_offset;
        let from = from_offset.max(head);
        let skip = (from - head) as usize;
        let bytes: Vec<u8> = job.ring.iter().skip(skip).copied().collect();
        let text = String::from_utf8_lossy(&bytes).to_string();
        Ok((text, head + job.ring.len() as u64))
    }

    /// Tail sample (last TAIL_SAMPLE bytes) — what a settled view shows.
    pub fn tail(&self, session_id: &str, id: &str) -> Result<String, String> {
        let (text, _) = {
            let job = self.job(session_id, id)?;
            let job = job.lock().unwrap();
            let skip = job.ring.len().saturating_sub(TAIL_SAMPLE);
            let bytes: Vec<u8> = job.ring.iter().skip(skip).copied().collect();
            (String::from_utf8_lossy(&bytes).to_string(), ())
        };
        Ok(text)
    }

    pub fn complete(&self, session_id: &str, id: &str, exit_code: Option<i32>) -> Result<(), String> {
        let job = self.job(session_id, id)?;
        {
            let mut job = job.lock().unwrap();
            job.projection.state = JobState::Completed { exit_code };
            job.projection.ended_at = Some(now_ms());
        }
        self.notify(&job);
        Ok(())
    }

    pub fn fail(&self, session_id: &str, id: &str, reason: &str) -> Result<(), String> {
        let job = self.job(session_id, id)?;
        {
            let mut job = job.lock().unwrap();
            job.projection.state = JobState::Failed {
                reason: reason.to_string(),
            };
            job.projection.ended_at = Some(now_ms());
        }
        self.notify(&job);
        Ok(())
    }

    /// Kill is only a request: set the cancel flag and record `Killed`. The
    /// runner converges — the UI never mutates job state directly.
    pub fn kill(&self, session_id: &str, id: &str, reason: &str) -> Result<(), String> {
        let job = self.job(session_id, id)?;
        let (flag, projection) = {
            let mut job = job.lock().unwrap();
            *job.child_cancel.lock().unwrap() = true;
            job.projection.state = JobState::Killed {
                reason: reason.to_string(),
            };
            job.projection.ended_at = Some(now_ms());
            (true, job.projection.clone())
        };
        self.notify_projection(&projection);
        let _ = flag;
        Ok(())
    }

    /// Hand the final result out ONCE. A second take errors.
    pub fn take_result(&self, session_id: &str, id: &str) -> Result<String, String> {
        let job = self.job(session_id, id)?;
        let mut job = job.lock().unwrap();
        if job.result_taken {
            return Err("Job result was already delivered.".into());
        }
        job.result_taken = true;
        job.result.clone().ok_or_else(|| "Job has no result yet.".into())
    }

    pub fn store_result(&self, session_id: &str, id: &str, result: &str) -> Result<(), String> {
        let job = self.job(session_id, id)?;
        job.lock().unwrap().result = Some(result.to_string());
        Ok(())
    }

    /// Snapshot of all jobs for one session (the jobs popover).
    pub fn list(&self, session_id: &str) -> Vec<Value> {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .filter_map(|j| {
                let j = j.lock().unwrap();
                if j.projection.session_id != session_id {
                    return None;
                }
                Some(json!({
                    "id": j.projection.id,
                    "title": j.projection.title,
                    "state": j.projection.state,
                    "startedAt": j.projection.started_at,
                    "endedAt": j.projection.ended_at,
                    "ringTotal": j.projection.ring_total_bytes,
                }))
            })
            .collect()
    }

    fn notify(&self, job: &Arc<Mutex<Job>>) {
        let projection = job.lock().unwrap().projection.clone();
        self.notify_projection(&projection);
    }

    fn notify_projection(&self, projection: &JobProjection) {
        if let Some(f) = self.on_change.lock().unwrap().as_ref() {
            f(projection);
        }
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> JobRegistry {
        JobRegistry::new()
    }

    #[test]
    fn ids_are_kind_sequential() {
        let reg = registry();
        let cancel = Arc::new(Mutex::new(false));
        let a = reg.admit("bash", "s1", "ls", cancel.clone());
        let b = reg.admit("bash", "s1", "ls", cancel);
        assert_eq!(a, "bash-1");
        assert_eq!(b, "bash-2");
    }

    #[test]
    fn session_fencing_hides_other_sessions_jobs() {
        let reg = registry();
        let cancel = Arc::new(Mutex::new(false));
        let id = reg.admit("bash", "s1", "x", cancel);
        assert!(reg.job("s2", &id).is_err());
        assert!(reg.job("s1", &id).is_ok());
    }

    #[test]
    fn ring_evicts_head_but_offsets_stay_absolute() {
        let reg = registry();
        let cancel = Arc::new(Mutex::new(false));
        let id = reg.admit("bash", "s1", "x", cancel);
        let blob = vec![b'x'; RING_LIVE_BYTES + 100];
        reg.write_output("s1", &id, &blob).unwrap();
        let job = reg.job("s1", &id).unwrap();
        let j = job.lock().unwrap();
        assert_eq!(j.ring.len(), RING_LIVE_BYTES);
        assert_eq!(j.head_offset, 100u64);
        assert_eq!(j.projection.ring_total_bytes, (RING_LIVE_BYTES + 100) as u64);
    }

    #[test]
    fn result_handed_out_once() {
        let reg = registry();
        let cancel = Arc::new(Mutex::new(false));
        let id = reg.admit("bash", "s1", "x", cancel);
        reg.store_result("s1", &id, "done").unwrap();
        assert_eq!(reg.take_result("s1", &id).unwrap(), "done");
        assert!(reg.take_result("s1", &id).is_err());
    }

    #[test]
    fn kill_sets_cancel_flag_and_state() {
        let reg = registry();
        let cancel = Arc::new(Mutex::new(false));
        let id = reg.admit("bash", "s1", "x", cancel.clone());
        reg.kill("s1", &id, "user asked").unwrap();
        assert!(*cancel.lock().unwrap());
        let jobs = reg.list("s1");
        assert_eq!(jobs[0]["state"]["state"], "killed");
    }
}
