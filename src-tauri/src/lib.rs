mod agent;
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
}

#[tauri::command]
fn native_status() -> String {
    "Rust native core online".to_owned()
}

#[tauri::command]
fn plugin_status(workspace: String) -> Vec<(&'static str, Vec<&'static str>)> {
    let registry = plugin::PluginRegistry::new(std::path::PathBuf::from(workspace));
    registry.descriptors().into_iter().map(|(id, caps)| (id, caps.to_vec())).collect()
}

#[tauri::command]
async fn run_agent(app: tauri::AppHandle, input: AgentRequest) -> Result<String, String> {
    let workspace = dunce::canonicalize(&input.workspace)
        .map_err(|e| format!("Invalid workspace: {e}"))?;
    if !workspace.is_dir() {
        return Err("Workspace must be a directory.".into());
    }
    agent::run(input.task_id, input.request, workspace, app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_status, plugin_status, run_agent])
        .run(tauri::generate_context!())
        .expect("error while running Entry Desktop");
}
