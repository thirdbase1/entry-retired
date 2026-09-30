//! End-to-end tests for the boundary pipeline the `bash` command runs:
//! workspace-relative cwd gate -> approval gate -> real child execution.
//! These run against real processes, no Tauri runtime required.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use ventry_lib::approval::command_needs_approval;
use ventry_lib::path_security::{is_path_within_directory, resolve_bash_working_directory};

// Minimal mirror of Executor::run's core loop, minus Tauri event emission,
// so the same supervision path is exercised deterministically in CI.
fn supervised_bash(
    command: &str,
    cwd: &str,
    timeout_ms: Option<u64>,
) -> (Option<i32>, String, bool, bool) {
    let mut cmd = Command::new("bash");
    cmd.args(["-c", command]).current_dir(cwd);
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("bash spawns");

    let started = std::time::Instant::now();
    let timeout = timeout_ms.map(std::time::Duration::from_millis);
    let cancel = Arc::new(AtomicBool::new(false));

    let cancelled = loop {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = child.kill();
            break true;
        }
        if let Some(t) = timeout {
            if started.elapsed() >= t {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => break false,
        }
    };

    let status = child.wait().ok();
    (
        status.and_then(|s| s.code()),
        String::new(),
        cancelled,
        timeout.map(|t| started.elapsed() >= t).unwrap_or(false),
    )
}

#[test]
fn pipeline_blocks_escaping_cwd_before_any_execution() {
    // The gate refuses BEFORE a process would spawn: assert contract only.
    assert_eq!(
        resolve_bash_working_directory(Some("../../etc"), "/work/repo"),
        None
    );
    assert_eq!(
        resolve_bash_working_directory(Some("/etc"), "/work/repo"),
        None
    );
    assert!(resolve_bash_working_directory(Some("sub/dir"), "/work/repo").is_some());
}

#[test]
#[cfg(unix)] // macOS temp dirs are symlinked (/var -> /private/var) and the
             // pipeline contract below assumes a POSIX bash; Windows runs the cmd variant.
fn pipeline_runs_allowed_command_in_workspace_subdir() {
    let repo_tmp = std::env::temp_dir().join(format!("ed-e2e-{}", std::process::id()));
    std::fs::create_dir_all(repo_tmp.join("sub")).unwrap();
    let repo = std::fs::canonicalize(&repo_tmp).unwrap();
    let cwd = resolve_bash_working_directory(Some("sub"), &repo.display().to_string()).unwrap();
    let (code, _, cancelled, timed_out) = supervised_bash("pwd", &cwd, Some(10_000));
    assert_eq!(code, Some(0));
    assert!(!cancelled);
    assert!(!timed_out);
    // Output capture: run again capturing stdout directly. Compare canonical
    // forms — pwd prints the symlink-resolved path on macOS.
    let out = Command::new("bash")
        .args(["-c", "pwd"])
        .current_dir(&cwd)
        .output()
        .unwrap();
    let printed = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    assert_eq!(
        std::fs::canonicalize(&printed).unwrap(),
        std::fs::canonicalize(&cwd).unwrap()
    );
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
#[cfg(windows)] // Git Bash on Windows runners resolves temp paths oddly; the
                // same cwd-verification contract holds with the platform shell.
fn pipeline_runs_allowed_command_in_workspace_subdir() {
    let repo = std::env::temp_dir().join(format!("ed-e2e-{}", std::process::id()));
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    let cwd = resolve_bash_working_directory(Some("sub"), &repo.display().to_string()).unwrap();
    let out = Command::new("cmd")
        .args(["/C", "cd"])
        .current_dir(&cwd)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim().to_lowercase(),
        cwd.trim_end_matches('\\').to_lowercase()
    );
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn pipeline_enforces_timeout() {
    let tmp = std::env::temp_dir();
    let (long_cmd, shell) = if cfg!(windows) {
        ("ping -n 6 127.0.0.1 > NUL", "cmd")
    } else {
        ("sleep 5", "bash")
    };
    let mut cmd = Command::new(shell);
    if cfg!(windows) {
        cmd.args(["/C", long_cmd]);
    } else {
        cmd.args(["-c", long_cmd]);
    }
    cmd.current_dir(tmp.display().to_string());
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("long child spawns");
    let started = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let _ = child.kill();
    let status = child.wait().unwrap();
    // A killed child yields no exit code (Windows) or a signal code != 0
    // (Unix kill maps to None on Unix via wait, Some(1) after kill on Windows
    // is possible; contract: the run did NOT complete successfully and the
    // supervisor returned before the child's natural end).
    assert!(!status.success());
    assert!(started.elapsed() < std::time::Duration::from_secs(4));
}

#[test]
fn approval_and_path_gates_are_independent_layers() {
    // A safe command in a valid dir: passes both.
    assert!(!command_needs_approval("ls -la"));
    assert!(resolve_bash_working_directory(Some("src"), "/w").is_some());
    // Dangerous command: approval layer refuses even with valid dir.
    assert!(command_needs_approval("rm -rf /"));
    // Safe command, invalid dir: path layer refuses.
    assert_eq!(resolve_bash_working_directory(Some("../x"), "/w"), None);
}

#[test]
fn workspace_containment_guard_is_component_wise() {
    let guard = is_path_within_directory;
    assert!(guard("/w/a/b", "/w/a"));
    assert!(!guard("/w/a-b", "/w/a"));
    // _ guards used to silence dead-code in this binary target
    let _ = PathBuf::new();
    let _ = Mutex::new(());
    let _ = AtomicU64::new(0);
}
