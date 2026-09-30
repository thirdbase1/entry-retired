//! Entry Desktop native core.
//!
//! Phase 2 runtime shape:
//!
//! ```text
//! Entry Agent → Command Contract → Native Runtime
//!                                   ├── Workspace (registration, boundary, policy)
//!                                   ├── Process Manager (lifecycle, ownership)
//!                                   └── Filesystem (gated, confined)
//! ```
//!
//! Tool contracts are ported from entry-agents (path_security, approval,
//! content_boundary, read_ceilings). The agent never receives an arbitrary
//! filesystem path; everything routes through the registered workspace.

pub mod approval;
pub mod approval_service;
mod content_boundary;
pub mod path_security;
pub mod process_manager;
pub mod read_ceilings;
pub mod workspace;

use std::sync::Mutex;

use content_boundary::wrap_external_file_content;
use process_manager::{ProcessEnd, ProcessManager, ProcessRecord};
use read_ceilings::{
    apply_byte_ceiling, clamp_line, is_device_path, is_likely_binary, normalize_file_content,
    select_lines, split_lines, SelectParams, READ_BYTE_CEILING,
};
use workspace::{Workspace, WorkspaceStatus};
pub use workspace::{WorkspaceMetadata, WorkspacePolicy};

use tauri::{Manager, State};

/// Upstream bash tool: combined output truncated after ~50,000 characters.
const BASH_OUTPUT_CEILING: usize = 50_000;
/// Upstream bash tool default timeout.
const BASH_DEFAULT_TIMEOUT_MS: u64 = 120_000;

pub struct AppState {
    /// Registered workspace. `None` until set_workspace succeeds — no
    /// execution ground, no tool runs.
    workspace: Mutex<Option<Workspace>>,
    processes: ProcessManager,
}

impl AppState {
    fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            processes: ProcessManager::new(),
        }
    }

    /// Fetch and re-verify the registered workspace. The root can vanish
    /// (unmount, rm -rf) after registration; every entry point re-checks.
    fn workspace(&self) -> Result<Workspace, String> {
        let guard = self.workspace.lock().unwrap();
        match guard.as_ref() {
            Some(ws) => match ws.verify() {
                WorkspaceStatus::Ready => Ok(ws.clone()),
                WorkspaceStatus::Missing { registered_root } => Err(format!(
                    "workspace no longer exists on disk: {registered_root}"
                )),
                WorkspaceStatus::Invalid { registered_root } => Err(format!(
                    "workspace root is no longer a directory: {registered_root}"
                )),
            },
            None => Err("no workspace registered; call set_workspace first".to_string()),
        }
    }
}

mod agent;
mod agent_loop;
mod backend;
mod device_auth;
mod integrations;
mod jobs;
mod session_log;
mod model_selection;
mod network;
mod plugin;
mod runtime;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    task_id: String,
    request: String,
    workspace: String,
    /// Optional reasoning-effort selection ("low"/"medium"/"high"/...).
    /// Sanitized against the model's real vocabulary before use.
    reasoning_effort: Option<String>,
    /// Model chosen in the picker (backend catalog id).
    model_id: Option<String>,
    /// Stable session identity — the log file, approval routing, and jobs all
    /// key off it. Empty means "derive one from task_id" (older callers).
    #[serde(default)]
    session_id: String,
}

#[tauri::command]
fn native_status() -> String {
    "Rust native core online".to_owned()
}

/// Register (or re-register) the workspace root. Rust canonicalizes the path
/// and owns the result; the UI only passes a user-chosen folder.
#[tauri::command]
fn set_workspace(state: State<AppState>, path: String) -> Result<WorkspaceMetadata, String> {
    let ws = Workspace::register(&path)?;
    let meta = ws.metadata();
    *state.workspace.lock().unwrap() = Some(ws);
    Ok(meta)
}

/// Workspace observation surface: root, status, metadata, policy.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    root: Option<String>,
    status: WorkspaceStatus,
    metadata: Option<WorkspaceMetadata>,
    policy: WorkspacePolicy,
}

#[tauri::command]
fn workspace_info(state: State<AppState>) -> WorkspaceSnapshot {
    let guard = state.workspace.lock().unwrap();
    match guard.as_ref() {
        Some(ws) => WorkspaceSnapshot {
            status: ws.verify(),
            root: Some(ws.root_display()),
            metadata: Some(ws.metadata()),
            policy: ws.policy().clone(),
        },
        None => WorkspaceSnapshot {
            root: None,
            status: WorkspaceStatus::Missing {
                registered_root: String::new(),
            },
            metadata: None,
            policy: WorkspacePolicy::default(),
        },
    }
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
    /// Process-manager handle for observation/cancellation.
    process_handle: u64,
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

/// Upstream-compatible bash command, running through the workspace gate and
/// the process manager. `cwd` must be workspace-relative. `task_id` associates
/// the spawned process with an agent task for lifecycle cleanup.
#[tauri::command(async)]
async fn bash(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    command: String,
    cwd: Option<String>,
    task_id: Option<String>,
) -> Result<BashResult, String> {
    let ws = state.workspace()?;

    if approval::command_needs_approval(&command) {
        // Runtime-enforced approval (goal.md §13): refusal, not a UI question.
        return Err(format!(
            "approval_required: `{command}` matches a dangerous command pattern"
        ));
    }

    let working_dir = ws.gate_execute(cwd.as_deref())?;
    let task_id = task_id.unwrap_or_else(|| "default".to_string());

    // ProcessManager is an Arc-backed registry: cheap to clone into the task.
    let processes = state.processes.clone();
    let rec: ProcessRecord = tauri::async_runtime::spawn_blocking(move || {
        processes.spawn(
            &app,
            task_id,
            "bash".to_string(),
            vec!["-c".to_string(), command],
            working_dir.display().to_string(),
            Some(BASH_DEFAULT_TIMEOUT_MS),
        )
    })
    .await
    .map_err(|e| format!("process supervisor failed: {e}"))?;

    let end = rec
        .end
        .clone()
        .ok_or("process ended without a terminal state")?;
    let (exit_code, cancelled) = match end {
        ProcessEnd::Exited { code } => (code, false),
        ProcessEnd::Cancelled => (None, true),
        ProcessEnd::TimedOut { after_ms } => {
            return Err(format!("command timed out after {after_ms}ms"));
        }
        ProcessEnd::SpawnFailed { reason } => return Err(reason),
    };

    let (stdout, out_trunc) = truncate_output(&rec.stdout);
    let (stderr, err_trunc) = truncate_output(&rec.stderr);

    Ok(BashResult {
        success: exit_code == Some(0),
        exit_code,
        stdout,
        stderr,
        truncated: out_trunc || err_trunc,
        cancelled,
        duration_ms: rec.duration_ms,
        process_handle: rec.handle,
    })
}

/// Cancel a live process by handle.
#[tauri::command]
fn cancel_process(state: State<AppState>, handle: u64) -> bool {
    state.processes.cancel(handle)
}

/// All process records (task → process association surface).
#[tauri::command]
fn process_list(state: State<AppState>) -> Vec<ProcessRecord> {
    state.processes.all_records()
}

/// Request cancellation of every process owned by a task (cleanup when the
/// task dies). Returns the handles that were signalled.
#[tauri::command]
fn cancel_task(state: State<AppState>, task_id: String) -> Vec<u64> {
    let handles = state.processes.handles_for_task(&task_id);
    for h in &handles {
        state.processes.cancel(*h);
    }
    handles
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

/// Read a workspace file through the workspace read gate, the three ceilings,
/// and the untrusted-content boundary.
#[tauri::command]
fn read_file(
    state: State<AppState>,
    path: String,
    offset: Option<i64>,
    limit: Option<usize>,
) -> Result<ReadResult, String> {
    let ws = state.workspace()?;

    if is_device_path(&path) {
        return Err(format!("refusing to read device path: {path}"));
    }

    let absolute = ws.gate_read(&path)?;

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

/// Whether a command would require approval (UI pre-warning surface).
#[tauri::command]
fn command_approval_required(command: String) -> bool {
    approval::command_needs_approval(&command)
}

/// Integration plugin descriptors for the UI: id, name, logo, connected
/// state, capabilities, and the browser URL used to connect.
#[tauri::command]
fn plugins() -> Vec<integrations::PluginDescriptor> {
    integrations::all_plugins()
}

#[tauri::command]
fn plugin_status(workspace: String) -> Vec<(&'static str, Vec<&'static str>)> {
    match plugin::PluginRegistry::new(std::path::PathBuf::from(workspace), None, None) {
        Ok(registry) => registry.descriptors(),
        Err(_) => vec![],
    }
}

/// A live agent run: the deps the loop reads (approvals, interrupt flag) plus
/// the project it belongs to. One run per session at a time.
struct ActiveRun {
    approvals: std::sync::Arc<approval_service::ApprovalService>,
    interrupt: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// App-wide registry of live runs + background jobs.
struct AgentHost {
    runs: Mutex<std::collections::HashMap<String, ActiveRun>>,
    jobs: jobs::JobRegistry,
}

impl AgentHost {
    fn new() -> Self {
        Self {
            runs: Mutex::new(std::collections::HashMap::new()),
            jobs: jobs::JobRegistry::new(),
        }
    }
}

#[tauri::command]
async fn run_agent(
    app: tauri::AppHandle,
    host: tauri::State<'_, AgentHost>,
    input: AgentRequest,
) -> Result<String, String> {
    let workspace =
        dunce::canonicalize(&input.workspace).map_err(|e| format!("Invalid workspace: {e}"))?;
    if !workspace.is_dir() {
        return Err("Workspace must be a directory.".into());
    }
    let session_id = if input.session_id.trim().is_empty() {
        input.task_id.clone()
    } else {
        input.session_id.clone()
    };

    // One live run per session: a second run for the same session is refused
    // (the UI drives a queue; the runtime never silently stacks turns).
    if host.runs.lock().unwrap().contains_key(&session_id) {
        return Err("This session already has a turn in flight.".into());
    }

    let approvals = std::sync::Arc::new(approval_service::ApprovalService::new());
    // Route approval prompts into the webview as events.
    {
        let handle = app.clone();
        let sid = session_id.clone();
        approvals.set_ui_notify(move |req| {
            use tauri::Emitter;
            let payload = serde_json::json!({
                "sessionId": sid,
                "callId": req.call_id,
                "toolName": req.tool_name,
                "reason": req.reason,
                "createdAt": req.created_at,
            });
            let _ = handle.emit("entry://approval-request", payload);
        });
    }
    let interrupt = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    host.runs.lock().unwrap().insert(
        session_id.clone(),
        ActiveRun {
            approvals: approvals.clone(),
            interrupt: interrupt.clone(),
        },
    );

    let deps = std::sync::Arc::new(agent_loop::AgentDeps {
        approvals,
        interrupt,
    });
    let session = crate::backend::BackendSession::load(&app);
    let result = agent_loop::run(
        &session_id,
        Some(input.request),
        workspace,
        app,
        input.reasoning_effort,
        input.model_id,
        session,
        deps,
    )
    .await;

    host.runs.lock().unwrap().remove(&session_id);
    result.map(|o| o.final_text)
}

/// The UI answers a pending approval prompt. Unknown ids are ignored so a
/// request always resolves through its timeout instead of being lost.
#[tauri::command]
fn answer_approval(
    host: tauri::State<'_, AgentHost>,
    session_id: String,
    call_id: String,
    decision: String,
) -> Result<bool, String> {
    let outcome = match decision.as_str() {
        "allow" | "allowed-once" => approval_service::ApprovalOutcome::AllowedOnce,
        "reject" | "rejected" => approval_service::ApprovalOutcome::Rejected,
        "cancel" | "cancelled" => approval_service::ApprovalOutcome::Cancelled,
        other => return Err(format!("Unknown approval decision: {other}")),
    };
    let runs = host.runs.lock().unwrap();
    match runs.get(&session_id) {
        Some(run) => Ok(run.approvals.answer(&call_id, outcome)),
        None => Ok(false),
    }
}

/// Interrupt the live turn for a session. Interrupt is a request: the loop
/// converges and records `turn.interrupted` itself.
#[tauri::command]
fn interrupt_agent(host: tauri::State<'_, AgentHost>, session_id: String) -> bool {
    let runs = host.runs.lock().unwrap();
    match runs.get(&session_id) {
        Some(run) => {
            run.interrupt
                .store(true, std::sync::atomic::Ordering::SeqCst);
            run.approvals.cancel_all();
            true
        }
        None => false,
    }
}

/// Set the approval policy for a live run (Ask | Never).
#[tauri::command]
fn set_approval_policy(
    host: tauri::State<'_, AgentHost>,
    session_id: String,
    policy: String,
) -> Result<bool, String> {
    let parsed = match policy.as_str() {
        "ask" => approval_service::ApprovalPolicy::Ask,
        "never" => approval_service::ApprovalPolicy::Never,
        other => return Err(format!("Unknown approval policy: {other}")),
    };
    let runs = host.runs.lock().unwrap();
    match runs.get(&session_id) {
        Some(run) => {
            run.approvals.set_policy(parsed);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Read the session log projection (turns → records) for UI replay.
#[tauri::command]
fn session_events(workspace: String, session_id: String) -> Result<Vec<serde_json::Value>, String> {
    let workspace = dunce::canonicalize(&workspace).map_err(|e| format!("Invalid workspace: {e}"))?;
    let log = session_log::SessionLog::open(&workspace, &session_id)?;
    log.project()
}

/// List background jobs for a session.
#[tauri::command]
fn job_list(host: tauri::State<'_, AgentHost>, session_id: String) -> Vec<serde_json::Value> {
    host.jobs.list(&session_id)
}

/// Kill is only a request — the registry records it and the runner converges.
#[tauri::command]
fn job_kill(host: tauri::State<'_, AgentHost>, session_id: String, job_id: String) -> Result<(), String> {
    host.jobs.kill(&session_id, &job_id, "user requested")
}

/// Read a window of job output by absolute offset.
#[tauri::command]
fn job_output(
    host: tauri::State<'_, AgentHost>,
    session_id: String,
    job_id: String,
    from_offset: u64,
) -> Result<serde_json::Value, String> {
    let (text, next) = host.jobs.read_output(&session_id, &job_id, from_offset)?;
    Ok(serde_json::json!({"text": text, "nextOffset": next}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing main window instead of a new one.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(AppState::new())
        .manage(AgentHost::new())
        .invoke_handler(tauri::generate_handler![
            native_status,
            // Workspace + process contracts (Phase 1-2)
            set_workspace,
            workspace_info,
            bash,
            read_file,
            command_approval_required,
            cancel_process,
            cancel_task,
            process_list,
            // Agent runtime + plugins (merged from remote)
            plugin_status,
            plugins,
            device_auth::device_start,
            device_auth::device_poll,
            device_auth::session_info,
            device_auth::sign_out,
            device_auth::model_catalog,
            run_agent,
            answer_approval,
            interrupt_agent,
            set_approval_policy,
            session_events,
            job_list,
            job_kill,
            job_output
        ])
        .run(tauri::generate_context!())
        .expect("error while running Entry Desktop");
}
