//! Entry Desktop native core.
//!
//! Boundaries ported from entry-agents so the desktop behaves like the
//! proven web implementation where behavior matters (path containment,
//! approval heuristics, content boundaries, read ceilings) while replacing
//! web/cloud-sandbox-only infrastructure with native capabilities.

// Public for integration tests and the future plugin surface; internal
// modules stay `pub(crate)`-capable as the plugin registry lands.
pub mod approval;
pub mod content_boundary;
mod executor;
pub mod path_security;
pub mod read_ceilings;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use content_boundary::wrap_external_file_content;
use executor::{detect_workspace, make_spec, Executor, RunResult, WorkspaceInfo};
use path_security::{is_dotenv_file_path, resolve_bash_working_directory, resolve_workspace_path};
use read_ceilings::{
    apply_byte_ceiling, clamp_line, is_device_path, is_likely_binary, normalize_file_content,
    select_lines, split_lines, SelectParams, READ_BYTE_CEILING,
};
use tauri::State;

/// Upstream bash tool: combined output is truncated after ~50,000 characters.
const BASH_OUTPUT_CEILING: usize = 50_000;
/// Upstream bash tool default timeout.
const BASH_DEFAULT_TIMEOUT_MS: u64 = 120_000;

pub struct AppState {
    executor: Executor,
    cancel_flags: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    /// The workspace root for this desktop session. Every path-bearing tool
    /// resolves against it (never against ambient process cwd).
    workspace: Mutex<String>,
}

impl AppState {
    fn new() -> Self {
        let cwd = std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| ".".to_string());
        Self {
            executor: Executor::default(),
            cancel_flags: Mutex::new(HashMap::new()),
            workspace: Mutex::new(cwd),
        }
    }

    fn workspace_root(&self) -> String {
        self.workspace.lock().unwrap().clone()
    }
}

#[tauri::command]
fn native_status() -> String {
    "Rust native core online".to_owned()
}

/// Set (or read back) the workspace root. The UI picks a folder; Rust owns it.
#[tauri::command]
fn set_workspace(state: State<AppState>, path: Option<String>) -> Result<String, String> {
    let mut ws = state.workspace.lock().unwrap();
    if let Some(p) = path {
        let canonical = std::fs::canonicalize(&p).map_err(|e| format!("invalid workspace: {e}"))?;
        if !canonical.is_dir() {
            return Err("workspace must be a directory".to_string());
        }
        *ws = canonical.display().to_string();
    }
    Ok(ws.clone())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BashResult {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    cancelled: bool,
    duration_ms: u64,
}

/// Upstream-compatible bash command.
///
/// Deliberate, observable contract points:
/// - `cwd` accepts ONLY a workspace-relative path (absolute is refused).
/// - Commands run via a non-interactive `bash -c`, matching upstream.
/// - Output is ceilinged at 50,000 chars with a `truncated` flag.
/// - Dangerous commands are refused by the runtime (approval gate).
#[tauri::command(async)]
async fn bash(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    command: String,
    cwd: Option<String>,
) -> Result<BashResult, String> {
    let workspace = state.workspace_root();

    let working_dir = resolve_bash_working_directory(cwd.as_deref(), &workspace).ok_or_else(
        || {
            "Invalid cwd: the bash working directory must be a workspace-relative path inside the workspace."
                .to_string()
        },
    )?;

    if approval::command_needs_approval(&command) {
        // Approval policy is enforced by the runtime, not the caller. Until an
        // approval channel exists, destructive commands are refused outright
        // rather than silently executed (goal.md §13).
        return Err(format!(
            "approval_required: `{command}` matches a dangerous command pattern"
        ));
    }

    let spec = make_spec(
        "bash".to_string(),
        vec!["-c".to_string(), command.clone()],
        Some(working_dir),
    );
    let flag = Arc::new(AtomicBool::new(false));
    state.cancel_flags.lock().unwrap().insert(0, flag.clone());

    let executor = state.executor.clone();
    let app_for_task = app.clone();
    let result: RunResult = tauri::async_runtime::spawn_blocking(move || {
        executor.run(&app_for_task, spec, flag, Some(BASH_DEFAULT_TIMEOUT_MS))
    })
    .await
    .map_err(|e| format!("executor task failed: {e}"))?;

    state.cancel_flags.lock().unwrap().remove(&0);

    let (stdout, out_truncated) = truncate_output(&result.stdout);
    let (stderr, err_truncated) = truncate_output(&result.stderr);

    Ok(BashResult {
        success: result.exit_code == Some(0),
        exit_code: result.exit_code,
        stdout,
        stderr,
        truncated: out_truncated || err_truncated,
        cancelled: result.cancelled,
        duration_ms: result.duration_ms,
    })
}

fn truncate_output(text: &str) -> (String, bool) {
    if text.len() <= BASH_OUTPUT_CEILING {
        return (text.to_string(), false);
    }
    let cut: String = text.chars().take(BASH_OUTPUT_CEILING).collect();
    (
        format!("{cut}\n… [output truncated at {BASH_OUTPUT_CEILING} characters]"),
        true,
    )
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    path: String,
    content: String,
    total_lines: usize,
    start_line: usize,
    end_line: usize,
    truncated: bool,
    next_offset: Option<usize>,
}

/// Read a workspace file with upstream's three ceilings and untrusted-content
/// boundary. Refuses device paths, workspace escapes, and binary content.
#[tauri::command]
fn read_file(
    state: State<AppState>,
    path: String,
    offset: Option<i64>,
    limit: Option<usize>,
) -> Result<ReadResult, String> {
    let workspace = state.workspace_root();

    if is_device_path(&path) {
        return Err(format!("refusing to read device path: {path}"));
    }

    let absolute = resolve_workspace_path(&path, &workspace)
        .ok_or_else(|| format!("path escapes the workspace: {path}"))?;

    if is_dotenv_file_path(&path) {
        return Err(format!(
            "approval_required: `{path}` is a credential-bearing dotenv file"
        ));
    }

    let raw =
        std::fs::read_to_string(&absolute).map_err(|e| format!("failed to read {path}: {e}"))?;

    if is_likely_binary(&raw) {
        return Err(format!(
            "{path} looks binary; refusing to return it as text"
        ));
    }

    let content = normalize_file_content(&raw);
    let lines = split_lines(&content);
    let total_lines = lines.len();

    let selected = select_lines(
        &lines,
        SelectParams {
            offset: offset.unwrap_or(1),
            limit: limit.unwrap_or(read_ceilings::READ_MAX_LINES),
        },
    );
    let (windowed, next_offset) = apply_byte_ceiling(selected, READ_BYTE_CEILING);

    let rendered: Vec<String> = windowed
        .lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let (clamped, _) = clamp_line(line);
            format!("{}: {clamped}", windowed.start_line + i)
        })
        .collect();

    let body = wrap_external_file_content(&path, &rendered.join("\n"));

    Ok(ReadResult {
        path,
        content: body,
        total_lines,
        start_line: windowed.start_line,
        end_line: windowed.end_line,
        truncated: windowed.truncated,
        next_offset,
    })
}

/// Whether a command would require approval. Lets the UI warn before running.
#[tauri::command]
fn command_approval_required(command: String) -> bool {
    approval::command_needs_approval(&command)
}

/// Workspace detection: git state plus project markers.
#[tauri::command]
fn workspace_info(state: State<AppState>, path: Option<String>) -> WorkspaceInfo {
    let root = match path {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(state.workspace_root()),
    };
    detect_workspace(&root)
}

/// Cancel the in-flight command.
#[tauri::command]
fn cancel_process(state: State<AppState>) -> bool {
    if let Some(flag) = state.cancel_flags.lock().unwrap().get(&0) {
        flag.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            native_status,
            set_workspace,
            bash,
            read_file,
            command_approval_required,
            workspace_info,
            cancel_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running Entry Desktop");
}
