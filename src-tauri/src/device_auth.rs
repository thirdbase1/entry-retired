//! Device-flow login Tauri commands. The UI calls `device_start`, opens the
//! returned verify URL in the system browser (opener plugin), then polls
//! `device_poll` until the token arrives; the session is stored in app data.

use crate::backend::{BackendSession, DEFAULT_BACKEND_URL};
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub verify_url: String,
    pub device_code: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

/// POST backend /api/desktop/device/start
#[tauri::command]
pub async fn device_start(_app: tauri::AppHandle) -> Result<DeviceStart, String> {
    let backend_url =
        std::env::var("ENTRY_BACKEND_URL").unwrap_or_else(|_| DEFAULT_BACKEND_URL.into());
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{backend_url}/api/desktop/device/start"))
        .header("x-entry-desktop", "tauri")
        .header("Origin", "tauri://localhost")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Backend unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Backend error {}", res.status()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let device_code = body
        .get("deviceCode")
        .and_then(|v| v.as_str())
        .ok_or("Missing deviceCode")?
        .to_string();
    let user_code = body
        .get("userCode")
        .and_then(|v| v.as_str())
        .ok_or("Missing userCode")?
        .to_string();
    let verify_url = body
        .get("verifyUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{backend_url}/desktop/device?code={user_code}"));
    Ok(DeviceStart {
        user_code,
        verify_url,
        device_code,
        interval_secs: body.get("interval").and_then(|v| v.as_u64()).unwrap_or(3),
        expires_in_secs: body
            .get("expiresIn")
            .and_then(|v| v.as_u64())
            .unwrap_or(900),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResult {
    pub status: String,
    pub session: Option<BackendSession>,
}

/// POST backend /api/desktop/device/poll. On `complete`, the session token is
/// stored and never returned to the UI again (the UI just knows it succeeded).
#[tauri::command]
pub async fn device_poll(
    app: tauri::AppHandle,
    device_code: String,
) -> Result<DevicePollResult, String> {
    let backend_url =
        std::env::var("ENTRY_BACKEND_URL").unwrap_or_else(|_| DEFAULT_BACKEND_URL.into());
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{backend_url}/api/desktop/device/poll"))
        .json(&json!({ "deviceCode": device_code }))
        .header("x-entry-desktop", "tauri")
        .header("Origin", "tauri://localhost")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Backend unreachable: {e}"))?;

    let status = res.status().as_u16();
    if status == 404 || status == 410 {
        return Ok(DevicePollResult {
            status: "expired".into(),
            session: None,
        });
    }
    if status == 403 {
        return Ok(DevicePollResult {
            status: "denied".into(),
            session: None,
        });
    }
    if !res.status().is_success() {
        return Err(format!("Backend error {status}"));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let poll_status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("pending")
        .to_string();

    if poll_status != "complete" {
        return Ok(DevicePollResult {
            status: poll_status,
            session: None,
        });
    }

    let token = body
        .get("sessionToken")
        .and_then(|v| v.as_str())
        .ok_or("Missing sessionToken")?
        .to_string();
    let user = body.get("user").cloned().unwrap_or(json!({}));
    let session = BackendSession {
        backend_url,
        session_token: token,
        username: user
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("entry")
            .to_string(),
        email: user
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };
    BackendSession::store(&app, &session)?;
    Ok(DevicePollResult {
        status: "complete".into(),
        session: Some(BackendSession {
            backend_url: session.backend_url.clone(),
            session_token: String::new(), // never expose the token back to the UI
            username: session.username.clone(),
            email: session.email.clone(),
        }),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(non_snake_case)]
pub struct SessionInfo {
    pub signedIn: bool,
    pub username: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub creditBalanceCents: Option<i64>,
}

/// Current login state + live billing snapshot.
#[tauri::command]
pub async fn session_info(app: tauri::AppHandle) -> Result<SessionInfo, String> {
    let Some(session) = BackendSession::load(&app) else {
        return Ok(SessionInfo {
            signedIn: false,
            username: None,
            email: None,
            plan: None,
            creditBalanceCents: None,
        });
    };
    match crate::backend::fetch_me(&session).await {
        Ok(me) => Ok(SessionInfo {
            signedIn: true,
            username: Some(me.user.username),
            email: Some(me.user.email),
            plan: Some(me.billing.plan),
            creditBalanceCents: Some(me.billing.creditBalanceCents),
        }),
        Err(e) if e == "SESSION_EXPIRED" => {
            BackendSession::clear(&app).map_err(|e| e)?;
            Ok(SessionInfo {
                signedIn: false,
                username: None,
                email: None,
                plan: None,
                creditBalanceCents: None,
            })
        }
        Err(e) => Err(e),
    }
}

/// Sign out: clear stored session.
#[tauri::command]
pub async fn sign_out(app: tauri::AppHandle) -> Result<bool, String> {
    BackendSession::clear(&app)?;
    Ok(true)
}

/// Model catalog for the picker (plan-gated, from the backend).
#[tauri::command]
pub async fn model_catalog(
    app: tauri::AppHandle,
) -> Result<Vec<crate::backend::CatalogModel>, String> {
    let session = BackendSession::load(&app).ok_or("Not signed in")?;
    crate::backend::fetch_models(&session).await
}
