//! Phase 2 lifecycle and failure-path tests.
//!
//! Covers: registration validation, boundary enforcement (execute + read),
//! process lifecycle (spawn→stream→complete), timeout kill, cancellation,
//! task association/cleanup, and crash handling — without a running Tauri
//! app (ProcessManager::spawn's event emission is the only app-touching
//! part, and Tauri emits are no-ops on a null handle... we instead test the
//! manager via real spawns using a stub AppHandle through the supervisor
//! path that does not require an app: see each test).

use entry_desktop_lib::path_security::is_path_within_directory;
use entry_desktop_lib::process_manager::{ProcessEnd, ProcessManager};
use entry_desktop_lib::workspace::{Workspace, WorkspaceStatus};

fn tmpdir(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!("entry-p2-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

// ---------- Workspace registration & boundary ----------

#[test]
fn register_rejects_nonexistent_root() {
    let p = tmpdir("missing");
    let path = p.join("nope").display().to_string();
    let err = Workspace::register(&path).unwrap_err();
    assert!(err.contains("cannot register workspace"), "got: {err}");
    // Windows: canonicalize must fail with os error 2 (not-found)
    assert!(cfg!(windows) || err.contains("No such file"), "got: {err}");
}

#[test]
fn register_rejects_file_root() {
    let p = tmpdir("file-root");
    let f = p.join("afile");
    std::fs::write(&f, "x").unwrap();
    let err = Workspace::register(&f.display().to_string()).unwrap_err();
    assert!(err.contains("must be a directory"), "got: {err}");
}

#[test]
fn register_canonicalizes_root() {
    let p = tmpdir("canon");
    let sub = p.join("ws");
    std::fs::create_dir_all(&sub).unwrap();
    // Trailing slash + interior dot must be canonicalized away.
    let ws = Workspace::register(&format!("{}/.", sub.display())).unwrap();
    assert_eq!(ws.root(), &sub.canonicalize().unwrap());
}

#[test]
fn execute_gate_refuses_escaping_cwd() {
    let p = tmpdir("escape");
    let ws = Workspace::register(&p.display().to_string()).unwrap();
    let err = ws.gate_execute(Some("../outside")).unwrap_err();
    assert!(err.contains("Invalid cwd"), "got: {err}");
}

#[test]
fn execute_gate_resolves_relative_cwd() {
    let p = tmpdir("relcwd");
    std::fs::create_dir_all(p.join("sub/deeper")).unwrap();
    let ws = Workspace::register(&p.display().to_string()).unwrap();
    let dir = ws.gate_execute(Some("sub/deeper")).unwrap();
    assert!(dir.starts_with(ws.root()));
    assert!(dir.ends_with("sub/deeper"));
}

#[test]
fn read_gate_refuses_outside_workspace() {
    let p = tmpdir("read-out");
    let ws = Workspace::register(&p.display().to_string()).unwrap();
    let err = ws.gate_read("/etc/passwd").unwrap_err();
    assert!(err.contains("escapes the workspace"), "got: {err}");
}

#[test]
fn read_gate_refuses_symlink_escape() {
    let p = tmpdir("symlink");
    let secret = p.join("secret.txt");
    std::fs::write(&secret, "top secret").unwrap();
    let ws_dir = p.join("ws");
    std::fs::create_dir_all(&ws_dir).unwrap();
    let ws = Workspace::register(&ws_dir.display().to_string()).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&secret, ws_dir.join("leak.txt")).unwrap();
        let err = ws.gate_read("leak.txt").unwrap_err();
        assert!(err.contains("leaves the workspace"), "got: {err}");
    }
}

#[test]
fn read_gate_allows_inside_file() {
    let p = tmpdir("read-in");
    std::fs::write(p.join("ok.txt"), "hello").unwrap();
    let ws = Workspace::register(&p.display().to_string()).unwrap();
    let f = ws.gate_read("ok.txt").unwrap();
    assert_eq!(std::fs::read_to_string(f).unwrap(), "hello");
}

#[test]
fn verify_reports_missing_root() {
    let p = tmpdir("vanish");
    let ws = Workspace::register(&p.display().to_string()).unwrap();
    std::fs::remove_dir_all(&p).unwrap();
    assert!(matches!(ws.verify(), WorkspaceStatus::Missing { .. }));
}

// ---------- Process lifecycle ----------

fn spawn_simple(
    mgr: &ProcessManager,
    cmd: &str,
    cwd: &str,
) -> entry_desktop_lib::process_manager::ProcessRecord {
    // Event emission goes to a dropped channel when no app handle exists;
    // ProcessManager::spawn takes &AppHandle — for tests we use the
    // supervisor's record path via spawn_with_recorder.
    // Cross-platform: Git Bash exists on Windows runners but rejects
    // 8.3-short-name temp cwds; cmd /C is the reliable Windows shell.
    let (program, args) = if cfg!(windows) {
        ("cmd", vec!["/C".into(), cmd.into()])
    } else {
        ("bash", vec!["-c".into(), cmd.into()])
    };
    mgr.spawn_recorder("default".into(), program.into(), args, cwd.into(), None)
}

#[test]
fn lifecycle_run_to_completion() {
    let p = tmpdir("life");
    let mgr = ProcessManager::new();
    let rec = spawn_simple(&mgr, "echo hello", &p.display().to_string());
    match rec.end.expect("terminal state") {
        ProcessEnd::Exited { code } => assert_eq!(code, Some(0)),
        other => panic!("unexpected end: {other:?}"),
    }
    assert!(rec.stdout.contains("hello"), "stdout: {}", rec.stdout);
    assert!(rec.duration_ms < 60_000);
}

#[test]
fn lifecycle_records_nonzero_exit() {
    let p = tmpdir("nonzero");
    let mgr = ProcessManager::new();
    let rec = spawn_simple(&mgr, "exit 3", &p.display().to_string());
    match rec.end.expect("terminal state") {
        ProcessEnd::Exited { code } => assert_eq!(code, Some(3)),
        other => panic!("unexpected end: {other:?}"),
    }
}

#[test]
fn lifecycle_timeout_kills_process() {
    let p = tmpdir("timeout");
    let mgr = ProcessManager::new();
    let started = std::time::Instant::now();
    let rec = mgr.spawn_recorder(
        "default".into(),
        (if cfg!(windows) { "ping" } else { "bash" }).into(),
        (if cfg!(windows) {
            // ping directly — cmd /C would make ping a grandchild that
            // child.kill() cannot terminate (Windows kills only cmd).
            vec!["-n".into(), "31".into(), "127.0.0.1".into()]
        } else {
            vec!["-c".into(), "sleep 30".into()]
        }),
        p.display().to_string(),
        Some(300),
    );
    match rec.end.expect("terminal state") {
        ProcessEnd::TimedOut { after_ms } => assert_eq!(after_ms, 300),
        other => panic!("unexpected end: {other:?}"),
    }
    // Real kill, not just flag-flip: must return well before the 30s sleep.
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn lifecycle_cancel_prevents_completion_report() {
    let p = tmpdir("cancel");
    let mgr = ProcessManager::new();
    // Long process; cancel via a second thread after it starts.
    let mgr2 = mgr.clone();
    let cwd = p.display().to_string();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let handles = mgr2.handles_for_task("cancel-me");
        for h in &handles {
            mgr2.cancel(*h);
        }
        handles
    });
    let rec = mgr.spawn_recorder(
        "cancel-me".into(),
        (if cfg!(windows) { "cmd" } else { "bash" }).into(),
        (if cfg!(windows) {
            vec!["/C".into(), "ping -n 11 127.0.0.1 > NUL".into()]
        } else {
            vec!["-c".into(), "sleep 10".into()]
        }),
        cwd,
        None,
    );
    let handles = t.join().unwrap();
    assert!(!handles.is_empty());
    assert!(matches!(rec.end, Some(ProcessEnd::Cancelled)));
}

#[test]
fn task_association_and_cleanup() {
    let p = tmpdir("task");
    let mgr = ProcessManager::new();
    let cwd = p.display().to_string();
    let _a = spawn_simple(&mgr, "true", &cwd);
    let mut handles = mgr.handles_for_task("default");
    handles.sort();
    assert!(!handles.is_empty());
    // cancel_task signals every process of the task
    let signalled = mgr.cancel_task("default");
    assert_eq!(signalled.len(), handles.len());
}

#[test]
fn spawn_failure_is_a_record_not_a_panic() {
    let p = tmpdir("spawnfail");
    let mgr = ProcessManager::new();
    let rec = mgr.spawn_recorder(
        "default".into(),
        "definitely-not-a-real-binary-xyz".into(),
        vec![],
        p.display().to_string(),
        None,
    );
    match rec.end.expect("terminal state") {
        ProcessEnd::SpawnFailed { .. } => {}
        other => panic!("unexpected end: {other:?}"),
    }
}

#[test]
fn workspace_root_disappearing_midflight_is_reported() {
    // gate_execute re-verifies the root each call.
    let p = tmpdir("midflight");
    let ws = Workspace::register(&p.display().to_string()).unwrap();
    let first = ws.gate_execute(None);
    assert!(first.is_ok());
    std::fs::remove_dir_all(&p).unwrap();
    let second = ws.gate_execute(None);
    assert!(second.is_err());
    assert!(second.unwrap_err().contains("no longer exists"));
}

// ---------- is_path_within_directory regression guard ----------

#[test]
fn within_directory_handles_edge_shapes() {
    // Signature: (file_path, directory) — file first, container second.
    assert!(is_path_within_directory("/tmp/ws/a/b", "/tmp/ws"));
    assert!(is_path_within_directory("/tmp/ws", "/tmp/ws"));
    assert!(!is_path_within_directory("/tmp/ws../evil", "/tmp/ws"));
    assert!(!is_path_within_directory("/tmp", "/tmp/ws"));
}
