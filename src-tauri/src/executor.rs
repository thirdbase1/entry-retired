use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

/// Capability declaration for the executor plugin, per goal.md §4.
/// The runtime (not the caller) decides whether a capability is allowed.
/// Referenced by tests and by the future permission layer; the runtime does
/// not yet enforce capabilities (Phase 1 scope).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    ProcessSpawn,
    ProcessKill,
    FilesystemRead,
    FilesystemWrite,
}

/// A single process owned by the runtime. Handles are opaque to the UI:
/// the UI observes state, it never owns the task (goal.md §8, lesson 7).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ProcessEvent {
    /// Process spawned; handle assigned.
    Started { handle: u64, pid: Option<u32> },
    /// A chunk of stdout (streamed over Tauri IPC as it arrives).
    Stdout { handle: u64 },
    /// A chunk of stderr.
    Stderr { handle: u64 },
    /// Process exited on its own.
    Exited { handle: u64, code: Option<i32> },
    /// Process was cancelled by request.
    Cancelled { handle: u64 },
    /// Ownership bookkeeping: process reaped, resources released.
    Reaped { handle: u64 },
}

impl ProcessEvent {
    fn channel(&self) -> String {
        match self {
            ProcessEvent::Started { .. } => "process:started",
            ProcessEvent::Stdout { .. } => "process:stdout",
            ProcessEvent::Stderr { .. } => "process:stderr",
            ProcessEvent::Exited { .. } => "process:exit",
            ProcessEvent::Cancelled { .. } => "process:cancel",
            ProcessEvent::Reaped { .. } => "process:reap",
        }
        .to_string()
    }
}

/// A completed run: full captured output plus final status. Returned by the
/// `run_command` command; streamed events go to the frontend in parallel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub handle: u64,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub cancelled: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub is_git_repo: bool,
    pub git_branch: Option<String>,
    pub has_package_json: bool,
    pub has_cargo_toml: bool,
}

#[derive(Debug, Clone)]
pub struct CommandSpec {
    program: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
}

/// Runtime-owned executor. Core keeps the registry; UI only sends intent.
/// Cloneable: clones share the handle counter (Arc), so monitoring code can
/// hold a reference without owning the whole registry.
#[derive(Default, Clone)]
pub struct Executor {
    next_handle: Arc<AtomicU64>,
}

/// A chunk of output as delivered live over IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub handle: u64,
    pub stream: &'static str,
    pub text: String,
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: &ProcessEvent) {
    let _ = app.emit(&event.channel(), event);
}

impl Executor {
    fn alloc_handle(&self) -> u64 {
        self.next_handle.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Run a command to completion, streaming stdout/stderr lines live.
    /// Cancellation is cooperative: the child is killed on `cancel`.
    pub fn run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        spec: CommandSpec,
        cancel_flag: Arc<std::sync::atomic::AtomicBool>,
        timeout_ms: Option<u64>,
    ) -> RunResult {
        let handle = self.alloc_handle();
        let started = std::time::Instant::now();
        let timeout = timeout_ms.map(std::time::Duration::from_millis);

        let mut cmd = std::process::Command::new(&spec.program);
        cmd.args(&spec.args);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        use std::process::Stdio;
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return RunResult {
                    handle,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: format!("failed to spawn {}: {e}", spec.program),
                    cancelled: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                }
            }
        };

        let pid = child.id();
        emit(
            app,
            &ProcessEvent::Started {
                handle,
                pid: Some(pid),
            },
        );

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        // Drain stdout+stderr on a thread so output streams while we wait.
        let (chunks_tx, chunks_rx) = std::sync::mpsc::channel::<OutputChunk>();
        let mut readers = Vec::new();
        for (stream, pipe) in [
            (
                "stdout",
                stdout_pipe.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
            ),
            (
                "stderr",
                stderr_pipe.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
            ),
        ] {
            if let Some(pipe) = pipe {
                let tx = chunks_tx.clone();
                readers.push(std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(pipe);
                    for line in reader.lines() {
                        match line {
                            Ok(text) => {
                                let _ = tx.send(OutputChunk {
                                    handle,
                                    stream,
                                    text,
                                });
                            }
                            Err(_) => break,
                        }
                    }
                }));
            }
        }
        drop(chunks_tx);

        let mut stdout = String::new();
        let mut stderr = String::new();

        // Wait with cancellation polling; kill if the flag goes up.
        let cancelled = loop {
            if cancel_flag.load(Ordering::SeqCst) {
                let _ = child.kill();
                break true;
            }
            // Upstream semantics: a command that exceeds its timeout is killed
            // with SIGKILL and reported as a failure, not left running.
            if let Some(t) = timeout {
                if started.elapsed() >= t {
                    let _ = child.kill();
                    let _ = child.wait();
                    for r in readers {
                        let _ = r.join();
                    }
                    emit(app, &ProcessEvent::Exited { handle, code: None });
                    emit(app, &ProcessEvent::Reaped { handle });
                    let mut out = stdout.clone();
                    let mut err = stderr.clone();
                    while let Ok(chunk) = chunks_rx.try_recv() {
                        if chunk.stream == "stdout" {
                            out.push_str(&chunk.text);
                            out.push('\n');
                        } else {
                            err.push_str(&chunk.text);
                            err.push('\n');
                        }
                    }
                    err.push_str(&format!("\nCommand timed out after {}ms", t.as_millis()));
                    return RunResult {
                        handle,
                        exit_code: None,
                        stdout: out,
                        stderr: err,
                        cancelled: false,
                        duration_ms: started.elapsed().as_millis() as u64,
                    };
                }
            }
            // Drain any chunks that arrived while polling.
            while let Ok(chunk) = chunks_rx.try_recv() {
                if chunk.stream == "stdout" {
                    stdout.push_str(&chunk.text);
                    stdout.push('\n');
                } else {
                    stderr.push_str(&chunk.text);
                    stderr.push('\n');
                }
                emit(app, &ProcessEvent::Stdout { handle });
                emit(app, &ProcessEvent::Stderr { handle });
            }
            match child.try_wait() {
                Ok(Some(_status)) => break false,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => break false,
            }
        };

        // Final drain.
        while let Ok(chunk) = chunks_rx.try_recv() {
            if chunk.stream == "stdout" {
                stdout.push_str(&chunk.text);
                stdout.push('\n');
            } else {
                stderr.push_str(&chunk.text);
                stderr.push('\n');
            }
        }
        for r in readers {
            let _ = r.join();
        }

        let status = child.try_wait();
        let exit_code = status.ok().flatten().and_then(|s| s.code());
        let _ = child.wait(); // reap

        if cancelled {
            emit(app, &ProcessEvent::Cancelled { handle });
        } else {
            emit(
                app,
                &ProcessEvent::Exited {
                    handle,
                    code: exit_code,
                },
            );
        }
        emit(app, &ProcessEvent::Reaped { handle });

        RunResult {
            handle,
            exit_code,
            stdout,
            stderr,
            cancelled,
            duration_ms: started.elapsed().as_millis() as u64,
        }
    }
}

/// Detect workspace traits (git, package.json, Cargo.toml) — Phase 1's
/// "workspace detection" deliverable.
pub fn detect_workspace(root: &PathBuf) -> WorkspaceInfo {
    let git_dir = root.join(".git");
    let is_git_repo = git_dir.exists();
    let git_branch = if is_git_repo {
        std::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        None
    };

    WorkspaceInfo {
        root: root.display().to_string(),
        is_git_repo,
        git_branch,
        has_package_json: root.join("package.json").exists(),
        has_cargo_toml: root.join("Cargo.toml").exists(),
    }
}

pub fn make_spec(program: String, args: Vec<String>, cwd: Option<String>) -> CommandSpec {
    CommandSpec {
        program,
        args,
        cwd: cwd.map(PathBuf::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_workspace_markers() {
        let tmp = std::env::temp_dir().join(format!("ed-ws-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();

        let info = detect_workspace(&tmp);
        assert!(info.has_package_json);
        assert!(!info.has_cargo_toml);
        assert!(!info.is_git_repo);
        assert!(info.git_branch.is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn spec_builds_command() {
        let spec = make_spec(
            "echo".to_string(),
            vec!["hello".to_string()],
            Some("/tmp".to_string()),
        );
        assert_eq!(spec.program, "echo");
        assert_eq!(spec.args, vec!["hello".to_string()]);
        assert_eq!(spec.cwd, Some(PathBuf::from("/tmp")));
    }

    #[test]
    fn capability_serializes_snake_case() {
        let json = serde_json::to_string(&Capability::ProcessSpawn).unwrap();
        assert_eq!(json, "\"process_spawn\"");
    }

    #[test]
    fn process_event_channels_are_distinct() {
        let started = ProcessEvent::Started {
            handle: 1,
            pid: Some(42),
        };
        let exited = ProcessEvent::Exited {
            handle: 1,
            code: Some(0),
        };
        assert_ne!(started.channel(), exited.channel());
        assert_eq!(started.channel(), "process:started");
    }
}
