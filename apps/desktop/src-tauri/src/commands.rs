//! Befehle für die Oberfläche. Eingaben werden hier geprüft; die Oberfläche sieht keine Tokens.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use timelog_core::http::{DeviceInfo, HttpApi, HttpResponse, LoginRequest, API_PREFIX};
use timelog_core::{Event, EventType, Span, SyncState, TrackerStatus};

use crate::runtime::{Runtime, REQUEST_TIMEOUT};

type Rt<'a> = State<'a, Arc<Runtime>>;
type CmdResult<T> = Result<T, String>;

const KEY_PROFILE: &str = "profile";
const KEY_SETUP_DONE: &str = "setup.done";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    logged_in: bool,
    base_url: Option<String>,
    setup_done: bool,
    sync: SyncState,
    pending: u64,
    tracker: TrackerStatus,
}

#[tauri::command]
pub fn get_state(rt: Rt<'_>) -> CmdResult<AppState> {
    let api = rt.api();
    Ok(AppState {
        logged_in: api.is_some(),
        base_url: api.map(|a| a.base_url().to_owned()),
        setup_done: rt
            .kv_get(KEY_SETUP_DONE)?
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        sync: rt.sync_state(),
        pending: rt.pending(),
        tracker: rt.tracker().status().map_err(|e| e.to_string())?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    base_url: String,
    email: String,
    password: String,
    totp: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    totp_setup_required: bool,
}

fn valid_base_url(url: &str) -> bool {
    let url = url.trim();
    // Klartext nur für die lokale Entwicklung.
    url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1")
}

#[tauri::command]
pub async fn login(rt: Rt<'_>, input: LoginInput) -> CmdResult<LoginResult> {
    if !valid_base_url(&input.base_url) {
        return Err("invalid_url".into());
    }
    let device_id = rt.api().map(|a| a.tokens().device_id);
    let request = LoginRequest {
        email: input.email,
        password: input.password,
        totp: input.totp.filter(|t| !t.is_empty()),
        device_id,
        device: DeviceInfo {
            kind: "desktop",
            os: crate::platform::device_os(),
            name: crate::platform::device_name(),
        },
    };
    let rt = Arc::clone(&rt);
    tauri::async_runtime::spawn_blocking(move || {
        let (api, totp_setup_required) = HttpApi::login(&input.base_url, &request, REQUEST_TIMEOUT)
            .map_err(|e| match e {
                timelog_core::ApiError::Rejected { code, .. } => code,
                timelog_core::ApiError::Unauthorized => "invalid_credentials".into(),
                timelog_core::ApiError::Unavailable(_) => "unavailable".into(),
            })?;
        rt.set_api(Some(api))?;
        rt.sync(true, None);
        Ok(LoginResult {
            totp_setup_required,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn logout(rt: Rt<'_>) -> CmdResult<()> {
    let rt = Arc::clone(&rt);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(api) = rt.api() {
            // Erst ausstehende Daten senden; scheitert das, bleiben sie lokal erhalten.
            rt.sync(true, None);
            let _ = api.logout();
        }
        rt.set_api(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

const ALLOWED_METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/// Leitet Anfragen des typisierten API-Clients (`@timelog/shared`) mit Token weiter.
#[tauri::command]
pub async fn api_fetch(
    rt: Rt<'_>,
    method: String,
    path: String,
    body: Option<String>,
) -> CmdResult<HttpResponse> {
    let method = method.to_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err("method_not_allowed".into());
    }
    let Some(path) = path.strip_prefix(API_PREFIX).map(str::to_owned) else {
        return Err("invalid_path".into());
    };
    if !path.starts_with('/') || path.starts_with("/auth/") || path.contains("..") {
        return Err("invalid_path".into());
    }
    let Some(api) = rt.api() else {
        return Ok(HttpResponse {
            status: 401,
            body: r#"{"error":"unauthorized"}"#.into(),
        });
    };
    let rt = Arc::clone(&rt);
    tauri::async_runtime::spawn_blocking(move || {
        let result = api
            .request(&method, &path, body.as_deref())
            .map_err(|e| e.to_string());
        rt.persist_tokens();
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct LocalData {
    events: Vec<Event>,
    spans: Vec<Span>,
}

#[tauri::command]
pub fn local_data(rt: Rt<'_>, from: DateTime<Utc>, to: DateTime<Utc>) -> CmdResult<LocalData> {
    if to <= from || to - from > chrono::Duration::days(400) {
        return Err("invalid_range".into());
    }
    let (events, spans) = rt
        .tracker()
        .local_data(from, to)
        .map_err(|e| e.to_string())?;
    Ok(LocalData { events, spans })
}

fn sync_soon(app: &AppHandle, rt: &Arc<Runtime>) {
    let rt = Arc::clone(rt);
    let app = app.clone();
    std::thread::spawn(move || {
        rt.sync(true, None);
        crate::notify_changed(&app);
    });
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ManualKind {
    ManualStart,
    ManualEnd,
}

#[tauri::command]
pub fn manual(app: AppHandle, rt: Rt<'_>, kind: ManualKind) -> CmdResult<Event> {
    let kind = match kind {
        ManualKind::ManualStart => EventType::ManualStart,
        ManualKind::ManualEnd => EventType::ManualEnd,
    };
    let event = rt
        .tracker()
        .manual(kind, Utc::now())
        .map_err(|e| e.to_string())?;
    sync_soon(&app, &rt);
    Ok(event)
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum RangeKind {
    ManualWork,
    ManualBreak,
}

#[tauri::command]
pub fn manual_range(
    app: AppHandle,
    rt: Rt<'_>,
    kind: RangeKind,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> CmdResult<Event> {
    let kind = match kind {
        RangeKind::ManualWork => EventType::ManualWork,
        RangeKind::ManualBreak => EventType::ManualBreak,
    };
    let event = rt
        .tracker()
        .manual_range(kind, from, to, Utc::now())
        .map_err(|e| e.to_string())?;
    sync_soon(&app, &rt);
    Ok(event)
}

#[tauri::command]
pub fn decide_session(
    app: AppHandle,
    rt: Rt<'_>,
    session_id: String,
    confirm: bool,
) -> CmdResult<Event> {
    if session_id.is_empty() || session_id.len() > 200 {
        return Err("invalid_session".into());
    }
    let event = rt
        .tracker()
        .decide_session(&session_id, confirm, Utc::now())
        .map_err(|e| e.to_string())?;
    sync_soon(&app, &rt);
    Ok(event)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentNetwork {
    fingerprint: Option<String>,
    ssid: Option<String>,
    bssid: Option<String>,
    wired: bool,
}

/// Aktuelles Netz für „aktuelles Netz übernehmen“; nur auf Nutzeraktion.
#[tauri::command]
pub fn current_network() -> CurrentNetwork {
    let info = crate::platform::system().current_network();
    CurrentNetwork {
        fingerprint: info.fingerprint,
        ssid: info.ssid,
        bssid: info.bssid,
        wired: info.wired,
    }
}

#[tauri::command]
pub fn get_profile(rt: Rt<'_>) -> CmdResult<Option<serde_json::Value>> {
    rt.kv_get(KEY_PROFILE)
}

#[tauri::command]
pub fn set_profile(rt: Rt<'_>, profile: serde_json::Value) -> CmdResult<()> {
    if !profile.is_object() || profile.to_string().len() > 64 * 1024 {
        return Err("invalid_profile".into());
    }
    rt.kv_set(KEY_PROFILE, &profile)
}

#[tauri::command]
pub fn finish_setup(rt: Rt<'_>) -> CmdResult<()> {
    rt.kv_set(KEY_SETUP_DONE, &serde_json::Value::Bool(true))
}

#[tauri::command]
pub async fn sync_now(app: AppHandle, rt: Rt<'_>) -> CmdResult<SyncState> {
    let rt = Arc::clone(&rt);
    tauri::async_runtime::spawn_blocking(move || {
        rt.sync(true, None);
        crate::notify_changed(&app);
        rt.sync_state()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Text des Tray-Symbols; berechnet die Oberfläche mit `@timelog/rules`.
#[tauri::command]
pub fn set_tray_status(app: AppHandle, text: String) -> CmdResult<()> {
    let text: String = text.chars().take(120).collect();
    crate::tray::set_tooltip(&app, &text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::valid_base_url;

    #[test]
    fn nur_https_ausser_lokal() {
        assert!(valid_base_url("https://zeit.example.de"));
        assert!(valid_base_url("http://localhost:3000"));
        assert!(!valid_base_url("http://zeit.example.de"));
        assert!(!valid_base_url("file:///etc/passwd"));
    }
}
