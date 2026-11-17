use futures_util::FutureExt;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, AppState};
use crate::models::*;
use crate::query;
use crate::schema;
use crate::store;

fn now_string() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn public_profile(mut profile: ConnectionProfile) -> ConnectionProfile {
    profile.has_password = store::profile_secret(&profile.id).is_some();
    profile.has_ssh_password = store::ssh_secret(&profile.id).is_some();
    profile
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> serde_json::Value {
    json!({
        "name": "Finch",
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "electron": "",
        "chrome": "",
        "node": "",
        "dataDir": store::data_dir().to_string_lossy(),
        "devView": std::env::var("FINCH_VIEW").unwrap_or_default(),
        "devTable": std::env::var("FINCH_DEMO_TABLE").unwrap_or_else(|_| "orders".into()),
    })
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionProfile> {
    state
        .profiles
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .map(public_profile)
        .collect()
}

fn normalize(mut profile: ConnectionProfile) -> ConnectionProfile {
    if profile.id.trim().is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    if profile.name.trim().is_empty() {
        profile.name = format!("{}@{}", profile.user, profile.host);
    }
    if profile.category.is_empty() {
        profile.category = "local".into();
    }
    if profile.color.is_empty() {
        profile.color = "#3f5bd9".into();
    }
    if profile.port == 0 {
        profile.port = 3306;
    }
    if profile.ssh_port == 0 {
        profile.ssh_port = 22;
    }
    if profile.keep_alive_seconds < 10 {
        profile.keep_alive_seconds = 30;
    }
    if profile.connect_timeout < 1500 {
        profile.connect_timeout = 10000;
    }
    if profile.created_at.is_empty() {
        profile.created_at = now_string();
    }
    profile.updated_at = now_string();
    profile
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    input: SaveConnectionInput,
) -> Result<ConnectionProfile, String> {
    let mut profile = normalize(input.connection);
    let existing = state
        .profiles
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.id == profile.id)
        .cloned();
    if let Some(existing) = existing {
        profile.created_at = existing.created_at;
        profile.last_connected_at = existing.last_connected_at;
    }
    if let Some(password) = input.password {
        if password.is_empty() {
            store::delete_profile_secrets(&profile.id);
        } else {
            store::set_profile_secret(&profile.id, &password)?;
        }
    }
    if let Some(password) = input.ssh_password {
        if password.is_empty() {
            store::set_ssh_secret(&profile.id, "")?;
        } else {
            store::set_ssh_secret(&profile.id, &password)?;
        }
    }
    let mut profiles = state.profiles.lock().unwrap();
    if let Some(item) = profiles.iter_mut().find(|p| p.id == profile.id) {
        *item = profile.clone();
    } else {
        profiles.push(profile.clone());
    }
    store::save_profiles(&profiles)?;
    Ok(public_profile(profile))
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let removed = { state.sessions.lock().unwrap().remove(&id) };
    if let Some(session) = removed {
        let _ = session.pool.clone().disconnect().await;
    }
    store::delete_profile_secrets(&id);
    let mut profiles = state.profiles.lock().unwrap();
    profiles.retain(|p| p.id != id);
    store::save_profiles(&profiles)?;
    Ok(true)
}

#[tauri::command]
pub async fn test_connection(
    input: TestConnectionInput,
) -> Result<serde_json::Value, String> {
    let connection = input.connection;
    let id = if connection.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        connection.id.clone()
    };
    let password = input
        .password
        .filter(|value| !value.is_empty())
        .or_else(|| if connection.id.is_empty() { None } else { store::profile_secret(&connection.id) })
        .unwrap_or_default();
    let profile = normalize(ConnectionProfile { id, ..connection });
    let session = db::open_session(&profile, &password).await?;
    let result = json!({
        "latency": session.latency,
        "version": session.version,
        "charset": session.server.get("charset").cloned().unwrap_or(json!("")),
        "threadId": session.thread_id,
        "host": profile.host,
        "port": profile.port,
    });
    let _ = session.pool.clone().disconnect().await;
    Ok(result)
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<SessionInfo, String> {
    let info = db::connect_state(&state, &id).await?;
    let _ = app.emit("finch://event", json!({"type":"session:status","id":id,"status":"connected","version":info.version}));
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let removed = { state.sessions.lock().unwrap().remove(&id) };
    if let Some(session) = removed {
        let _ = session.pool.clone().disconnect().await;
    }
    let _ = app.emit("finch://event", json!({"type":"session:status","id":id,"status":"offline"}));
    Ok(true)
}

#[tauri::command]
pub async fn ping(state: State<'_, AppState>, id: String) -> Result<SessionInfo, String> {
    db::ping_state(&state, &id).await
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<DatabaseInfo>, String> {
    schema::list_databases(&state, &session_id).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    kind: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    schema::list_tables(&state, &session_id, &database, kind.as_deref().unwrap_or("table")).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    schema::list_columns(&state, &session_id, &database, &table).await
}

#[tauri::command]
pub async fn get_table_details(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    table: String,
) -> Result<TableDetails, String> {
    schema::get_table_details(&state, &session_id, &database, &table).await
}

#[tauri::command]
pub async fn list_routines(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> Result<Vec<serde_json::Value>, String> {
    schema::list_routines(&state, &session_id, &database).await
}

#[tauri::command]
pub async fn execute_query(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: QueryPayload,
) -> Result<QueryResult, String> {
    if let Some(session) = state.sessions.lock().unwrap().get(&payload.session_id).cloned() {
        let _ = app.emit("finch://event", json!({"type":"session:ping","id":session.id,"latency":session.latency}));
    }
    // A task panic must reject the IPC promise, otherwise the UI keeps loading.
    std::panic::AssertUnwindSafe(query::execute(&state, payload))
        .catch_unwind()
        .await
        .map_err(|_| "查询处理发生内部异常，请重试或复制 SQL 反馈".to_string())?
}

#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    execution_id: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let cancelled = query::cancel(&state, &execution_id, &session_id).await?;
    Ok(json!({"cancelled": cancelled}))
}

#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_id = payload.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let database = payload.get("database").and_then(|v| v.as_str()).unwrap_or("");
    let sql = payload.get("sql").and_then(|v| v.as_str()).unwrap_or("");
    schema::explain(&state, session_id, database, sql).await
}

#[tauri::command]
pub async fn count_table_rows(
    state: State<'_, AppState>,
    payload: TableDataPayload,
) -> Result<Option<u64>, String> {
    schema::count_rows(&state, payload).await
}

#[tauri::command]
pub async fn list_all_columns(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> Result<std::collections::HashMap<String, Vec<ColumnInfo>>, String> {
    schema::all_columns(&state, &session_id, &database).await
}

#[tauri::command]
pub async fn get_table_data(
    state: State<'_, AppState>,
    payload: TableDataPayload,
) -> Result<TableData, String> {
    schema::get_table_data(&state, payload).await
}

#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    payload: UpdateCellPayload,
) -> Result<serde_json::Value, String> {
    let affected = schema::update_cell(&state, payload).await?;
    Ok(json!({"affectedRows": affected}))
}

#[tauri::command]
pub async fn delete_rows(
    state: State<'_, AppState>,
    payload: DeleteRowsPayload,
) -> Result<serde_json::Value, String> {
    let deleted = schema::delete_rows(&state, payload).await?;
    Ok(json!({"deleted": deleted}))
}

#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    payload: InsertRowPayload,
) -> Result<serde_json::Value, String> {
    let (insert_id, affected) = schema::insert_row(&state, payload).await?;
    Ok(json!({"insertId": insert_id, "affectedRows": affected}))
}

#[tauri::command]
pub async fn server_overview(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ServerOverview, String> {
    schema::server_overview(&state, &session_id).await
}

#[tauri::command]
pub async fn server_processes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ProcessInfo>, String> {
    schema::list_processes(&state, &session_id).await
}

#[tauri::command]
pub async fn kill_process(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_id = payload.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let thread_id = payload.get("threadId").and_then(|v| v.as_u64()).unwrap_or(0);
    let killed = schema::kill_process(&state, session_id, thread_id).await?;
    Ok(json!({"killed": killed}))
}

#[tauri::command]
pub async fn server_variables(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    schema::server_variables(&state, &session_id).await
}

#[tauri::command]
pub fn list_history(state: State<'_, AppState>) -> Vec<HistoryItem> {
    state.history.lock().unwrap().clone()
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<bool, String> {
    let mut history = state.history.lock().unwrap();
    history.clear();
    store::save_history(&history)?;
    Ok(true)
}

#[tauri::command]
pub fn delete_history(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut history = state.history.lock().unwrap();
    history.retain(|item| item.id != id);
    store::save_history(&history)?;
    Ok(true)
}

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Vec<SavedQuery> {
    state.snippets.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, input: SavedQuery) -> Result<SavedQuery, String> {
    let mut item = input;
    if item.id.is_empty() {
        item.id = uuid::Uuid::new_v4().to_string();
        item.created_at = now_string();
    }
    item.updated_at = now_string();
    let mut snippets = state.snippets.lock().unwrap();
    if let Some(existing) = snippets.iter_mut().find(|s| s.id == item.id) {
        *existing = item.clone();
    } else {
        snippets.insert(0, item.clone());
    }
    store::save_snippets(&snippets)?;
    Ok(item)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut snippets = state.snippets.lock().unwrap();
    snippets.retain(|s| s.id != id);
    store::save_snippets(&snippets)?;
    Ok(true)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    let mut current = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
    if let (Some(target), Some(patch)) = (current.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    *settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
    store::save_settings(&settings)?;
    Ok(settings.clone())
}

#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let mode = match theme.as_str() {
            "light" => Some(tauri::Theme::Light),
            "dark" => Some(tauri::Theme::Dark),
            _ => None,
        };
        let _ = window.set_theme(mode);
    }
    Ok(true)
}

#[tauri::command]
pub fn set_webview_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<bool, String> {
    let scale = if scale.is_finite() { scale.clamp(0.5, 2.5) } else { 1.0 };
    window.set_zoom(scale).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn set_title(app: AppHandle, title: String) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&title);
    }
    Ok(true)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<bool, String> {
    store::write_text_file(&path, &content)?;
    Ok(true)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    store::read_text_file(&path)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<bool, String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn list_ai_providers(state: State<'_, AppState>) -> Vec<AiProvider> {
    crate::ai::list(&state)
}

#[tauri::command]
pub fn save_ai_provider(state: State<'_, AppState>, input: AiProviderInput) -> Result<AiProvider, String> {
    crate::ai::save(&state, input)
}

#[tauri::command]
pub fn delete_ai_provider(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    crate::ai::delete(&state, &id)
}

#[tauri::command]
pub async fn generate_sql(
    state: State<'_, AppState>,
    input: AiGenerateInput,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    std::panic::AssertUnwindSafe(crate::ai::generate(&state, input, |event| on_event.send(event).map_err(|e| e.to_string())))
        .catch_unwind().await.map_err(|_| "AI 生成任务异常，已停止接收，请重试".to_string())?
}

#[tauri::command]
pub fn cancel_ai(state: State<'_, AppState>, request_id: String) -> bool {
    crate::ai::cancel(&state, &request_id)
}

#[tauri::command]
pub async fn sync_preview(
    state: State<'_, AppState>,
    source_id: String,
    target_id: String,
    source_database: String,
    target_database: String,
) -> Result<serde_json::Value, String> {
    crate::sync::preview(&state, &source_id, &target_id, &source_database, &target_database).await
}

#[tauri::command]
pub async fn run_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SyncRequest,
) -> Result<SyncResult, String> {
    crate::sync::run(Some(&app), &state, request).await
}

#[tauri::command]
pub async fn create_table(
    state: State<'_, AppState>,
    request: CreateTableRequest,
) -> Result<String, String> {
    crate::ddl::create_table(&state, request).await
}

#[tauri::command]
pub async fn alter_table(
    state: State<'_, AppState>,
    request: AlterTableRequest,
) -> Result<String, String> {
    crate::ddl::alter_table(&state, request).await
}

#[tauri::command]
pub async fn drop_table(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    crate::ddl::drop_table(&state, &session_id, &database, &table).await
}

#[tauri::command]
pub async fn dump_database(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DumpRequest,
) -> Result<serde_json::Value, String> {
    crate::dump::dump(Some(&app), &state, request).await
}
