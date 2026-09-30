//! Desktop backend session — the connection between the app and the deployed
//! backend (entry-desktop-backend.vercel.app). The device-flow login stores a
//! session token in the OS keychain (via tauri-plugin-stronghold on desktop,
//! or the app data dir with restricted permissions as the Phase-3 fallback);
//! this module resolves it and exposes the backend-backed model client.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Manager;
pub const DEFAULT_BACKEND_URL: &str = "https://entry-desktop-backend.vercel.app";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSession {
    pub backend_url: String,
    pub session_token: String,
    pub username: String,
    pub email: String,
}

impl BackendSession {
    fn storage_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("No app data dir: {e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create app data: {e}"))?;
        Ok(dir.join("session.json"))
    }

    /// Persist the session after a successful device-flow login.
    pub fn store(app: &tauri::AppHandle, session: &BackendSession) -> Result<(), String> {
        let path = Self::storage_path(app)?;
        let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
        // Restrict permissions: owner read/write only (POSIX; no-op elsewhere).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::write(path, json).map_err(|e| format!("Cannot write session: {e}"))
    }

    pub fn load(app: &tauri::AppHandle) -> Option<BackendSession> {
        let path = Self::storage_path(app).ok()?;
        let json = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&json).ok()
    }

    pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        let path = Self::storage_path(app)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn is_configured(app: &tauri::AppHandle) -> bool {
        Self::load(app).is_some()
    }
}

// ---------------------------------------------------------------------------
// Backend API responses
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct MeResponse {
    pub user: BackendUser,
    pub billing: BillingState,
}

#[derive(Debug, Deserialize)]
pub struct BackendUser {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub avatar: String,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub struct BillingState {
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub creditBalanceCents: i64,
    #[serde(default)]
    pub planGrantBalanceCents: i64,
    #[serde(default)]
    pub isAdmin: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_levels: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

/// Fetch /api/desktop/me with the stored session.
pub async fn fetch_me(session: &BackendSession) -> Result<MeResponse, String> {
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}/api/desktop/me", session.backend_url))
        .bearer_auth(&session.session_token)
        .header("x-entry-desktop", "tauri")
        .header("Origin", "tauri://localhost")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Backend unreachable: {e}"))?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("SESSION_EXPIRED".into());
    }
    if !res.status().is_success() {
        return Err(format!("Backend error {}", res.status()));
    }
    res.json().await.map_err(|e| format!("Bad response: {e}"))
}

/// POST /api/desktop/signout — revoke the session row server-side (best effort).
pub async fn revoke_session(session: &BackendSession) -> Result<(), String> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/api/desktop/signout", session.backend_url))
        .bearer_auth(&session.session_token)
        .header("x-entry-desktop", "tauri")
        .header("Origin", "tauri://localhost")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Backend unreachable: {e}"))?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Backend error {}", res.status()))
    }
}

/// Fetch /api/desktop/models — the plan-gated gateway catalog.
pub async fn fetch_models(session: &BackendSession) -> Result<Vec<CatalogModel>, String> {
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}/api/desktop/models", session.backend_url))
        .bearer_auth(&session.session_token)
        .header("x-entry-desktop", "tauri")
        .header("Origin", "tauri://localhost")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Backend unreachable: {e}"))?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("SESSION_EXPIRED".into());
    }
    if !res.status().is_success() {
        return Err(format!("Backend error {}", res.status()));
    }
    #[derive(Deserialize)]
    struct ModelsResponse {
        models: Vec<CatalogModel>,
    }
    let body: ModelsResponse = res.json().await.map_err(|e| format!("Bad response: {e}"))?;
    Ok(body.models)
}
