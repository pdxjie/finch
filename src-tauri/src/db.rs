use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, SslOpts, Value};
use serde_json::{json, Value as Json};
use tokio::sync::Notify;

use crate::models::*;
use crate::ssh::{self, Tunnel};
use crate::store;

pub struct Session {
    pub id: String,
    pub profile: ConnectionProfile,
    pub pool: Pool,
    /// Standalone connection options, used for out-of-band `KILL QUERY`.
    pub opts: Opts,
    pub version: String,
    pub server: Json,
    pub latency: u64,
    pub connected_at: i64,
    pub thread_id: u32,
    /// Kept alive for the lifetime of the session; dropping it closes the tunnel.
    #[allow(dead_code)]
    pub tunnel: Mutex<Option<Tunnel>>,
    pub last_error: Mutex<Option<String>>,
    pub heartbeat_running: AtomicBool,
    pub last_heartbeat: Mutex<Instant>,
}

pub struct QueryControl {
    pub thread_id: Mutex<Option<u32>>,
    pub cancelled: AtomicBool,
    wake: Notify,
}

impl QueryControl {
    pub fn new() -> Self {
        Self { thread_id: Mutex::new(None), cancelled: AtomicBool::new(false), wake: Notify::new() }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.wake.notify_one();
    }

    pub async fn wait_cancelled(&self) {
        // notify_one retains a permit if Cancel arrives before we start waiting.
        if !self.cancelled.load(Ordering::Relaxed) {
            self.wake.notified().await;
        }
    }
}

pub struct AppState {
    pub profiles: Mutex<Vec<ConnectionProfile>>,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub settings: Mutex<AppSettings>,
    pub history: Arc<Mutex<Vec<HistoryItem>>>,
    pub snippets: Mutex<Vec<SavedQuery>>,
    pub ai_providers: Mutex<Vec<AiProvider>>,
    pub cancels: Mutex<HashMap<String, Arc<QueryControl>>>,
    pub ai_cancels: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

pub fn is_cancelled(state: &AppState, execution_id: &str) -> bool {
    state
        .cancels
        .lock()
        .unwrap()
        .get(execution_id)
        .map(|control| control.cancelled.load(Ordering::Relaxed))
        .unwrap_or(false)
}

impl AppState {
    pub fn new() -> Self {
        Self {
            profiles: Mutex::new(store::load_profiles()),
            sessions: Mutex::new(HashMap::new()),
            settings: Mutex::new(store::load_settings()),
            history: Arc::new(Mutex::new(store::load_history())),
            snippets: Mutex::new(store::load_snippets()),
            ai_providers: Mutex::new(store::load_ai_providers()),
            cancels: Mutex::new(HashMap::new()),
            ai_cancels: Mutex::new(HashMap::new()),
        }
    }

    pub fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "连接尚未建立，请重新连接".to_string())
    }

    pub fn profile(&self, id: &str) -> Result<ConnectionProfile, String> {
        self.profiles
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| "连接不存在".to_string())
    }

    /// Read the current configuration so changing read-only takes effect without reconnecting.
    pub fn ensure_writable(&self, id: &str) -> Result<(), String> {
        if self.profile(id)?.read_only {
            return Err("连接处于只读模式，已阻止写入和结构变更".into());
        }
        Ok(())
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

fn build_pool(
    profile: &ConnectionProfile,
    password: &str,
    host: &str,
    port: u16,
) -> Result<(Pool, Opts), String> {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(profile.user.clone()))
        .pass(Some(password.to_string()))
        .prefer_socket(Some(false))
        .tcp_keepalive(Some(Duration::from_secs(profile.keep_alive_seconds.max(1))))
        .stmt_cache_size(32)
        .pool_opts(
            PoolOpts::default()
                .with_constraints(PoolConstraints::new(1, 8).unwrap())
                .with_inactive_connection_ttl(Duration::from_secs(90)),
        );
    if !profile.database.trim().is_empty() {
        builder = builder.db_name(Some(profile.database.clone()));
    }
    match profile.ssl_mode.as_str() {
        "required" => {
            builder = builder.ssl_opts(Some(
                SslOpts::default()
                    .with_danger_accept_invalid_certs(true)
                    .with_danger_skip_domain_validation(true),
            ));
        }
        "verify" => {
            let mut ssl = SslOpts::default();
            if !profile.ssl_ca_path.trim().is_empty() {
                ssl = ssl.with_root_certs(vec![std::path::PathBuf::from(expand_home(&profile.ssl_ca_path)).into()]);
            }
            builder = builder.ssl_opts(Some(ssl));
        }
        _ => {}
    }
    let opts: Opts = builder.into();
    Ok((Pool::new(opts.clone()), opts))
}

pub async fn open_session(profile: &ConnectionProfile, password: &str) -> Result<Arc<Session>, String> {
    let mut tunnel = None;
    let (host, port) = if profile.ssh_enabled {
        let t = ssh::start(profile)?;
        let port = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), port)
    } else {
        (profile.host.clone(), profile.port)
    };
    let (pool, opts) = build_pool(profile, password, &host, port)?;
    let started = Instant::now();
    let mut conn = tokio::time::timeout(
        Duration::from_millis(profile.connect_timeout.max(1500)),
        pool.get_conn(),
    )
    .await
    .map_err(|_| "连接超时，请检查主机、端口、防火墙或 SSH 隧道".to_string())?
    .map_err(|e| format!("连接失败: {e}"))?;
    let row = tokio::time::timeout(
        Duration::from_secs(8),
        conn.query_first::<Row, _>(
            "SELECT VERSION() AS version, @@character_set_server AS charset, \
             @@lower_case_table_names AS lowerCase, CONNECTION_ID() AS threadId, \
             @@max_connections AS maxConnections, @@wait_timeout AS waitTimeout",
        ),
    )
    .await
    .map_err(|_| "握手成功但查询超时".to_string())?
    .map_err(|e| format!("握手查询失败: {e}"))?
    .ok_or_else(|| "服务器没有返回版本信息".to_string())?;
    let version: String = row.get(0).unwrap_or_default();
    let charset: String = row.get(1).unwrap_or_default();
    let lower_case: u64 = row.get(2).unwrap_or(0);
    let thread_id: u64 = row.get(3).unwrap_or(0);
    let max_connections: u64 = row.get(4).unwrap_or(0);
    let wait_timeout: u64 = row.get(5).unwrap_or(0);
    let latency = started.elapsed().as_millis() as u64;
    drop(conn);
    Ok(Arc::new(Session {
        id: profile.id.clone(),
        profile: profile.clone(),
        pool,
        opts,
        version,
        server: json!({
            "charset": charset,
            "lowerCase": lower_case,
            "threadId": thread_id,
            "maxConnections": max_connections,
            "waitTimeout": wait_timeout,
        }),
        latency,
        connected_at: now_ms(),
        thread_id: thread_id as u32,
        tunnel: Mutex::new(tunnel),
        last_error: Mutex::new(None),
        heartbeat_running: AtomicBool::new(false),
        last_heartbeat: Mutex::new(Instant::now()),
    }))
}

pub fn session_info(session: &Session) -> SessionInfo {
    SessionInfo {
        id: session.id.clone(),
        status: "connected".into(),
        version: session.version.clone(),
        server: session.server.clone(),
        latency: Some(session.latency),
        connected_at: session.connected_at,
        reconnect_attempts: None,
        last_error: session.last_error.lock().unwrap().clone(),
    }
}

pub async fn connect_state(state: &AppState, id: &str) -> Result<SessionInfo, String> {
    let profile = state.profile(id)?;
    let password = store::profile_secret(id).unwrap_or_default();
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.remove(id);
    }
    let session = open_session(&profile, &password).await?;
    let info = session_info(&session);
    state.sessions.lock().unwrap().insert(id.to_string(), session);
    let mut profiles = state.profiles.lock().unwrap();
    if let Some(item) = profiles.iter_mut().find(|p| p.id == id) {
        item.last_connected_at = Some(chrono::Utc::now().to_rfc3339());
        let _ = store::save_profiles(&profiles);
    }
    let mut settings = state.settings.lock().unwrap();
    settings.last_connection_id = Some(id.to_string());
    let _ = store::save_settings(&settings);
    Ok(info)
}

pub async fn reconnect_state(state: &AppState, id: &str) -> Result<Arc<Session>, String> {
    let previous = state.session(id)?;
    let profile = state.profile(id)?;
    if !profile.auto_reconnect {
        return Err("自动重连已关闭，请手动重新连接".into());
    }
    let password = store::profile_secret(id).unwrap_or_default();
    let session = open_session(&profile, &password).await?;
    // A user may disconnect or replace the session while the handshake is in flight.
    let installed = {
        let mut sessions = state.sessions.lock().unwrap();
        if sessions.get(id).is_some_and(|current| Arc::ptr_eq(current, &previous))
            && state.profile(id).is_ok_and(|p| p.auto_reconnect)
        {
            sessions.insert(id.to_string(), session.clone());
            true
        } else {
            false
        }
    };
    if !installed {
        let _ = tokio::time::timeout(Duration::from_secs(1), session.pool.clone().disconnect()).await;
        return Err("连接状态已改变，已放弃自动重连".into());
    }
    Ok(session)
}

pub async fn ping_state(state: &AppState, id: &str) -> Result<SessionInfo, String> {
    let session = state.session(id)?;
    let latency = ping_session(&session).await?;
    let mut info = session_info(&session);
    info.latency = Some(latency);
    Ok(info)
}

pub async fn ping_session(session: &Session) -> Result<u64, String> {
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(6), async {
        let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
        conn.ping().await.map_err(|e| e.to_string())
    }).await.map_err(|_| "ping 超时（包括连接等待）".to_string())??;
    Ok(started.elapsed().as_millis() as u64)
}

pub fn is_connection_error(message: &str) -> bool {
    let m = message.to_lowercase();
    ["broken pipe", "connection", "server has gone away", "eof", "reset by peer", "closed"]
        .iter()
        .any(|needle| m.contains(needle))
}

pub fn quote_id(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

pub fn qualify(database: &str, table: &str) -> String {
    format!("{}.{}", quote_id(database), quote_id(table))
}

fn column_type_name(column_type: ColumnType) -> &'static str {
    match column_type {
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
        ColumnType::MYSQL_TYPE_TINY => "TINYINT",
        ColumnType::MYSQL_TYPE_SHORT => "SMALLINT",
        ColumnType::MYSQL_TYPE_LONG => "INT",
        ColumnType::MYSQL_TYPE_FLOAT => "FLOAT",
        ColumnType::MYSQL_TYPE_DOUBLE => "DOUBLE",
        ColumnType::MYSQL_TYPE_NULL => "NULL",
        ColumnType::MYSQL_TYPE_TIMESTAMP => "TIMESTAMP",
        ColumnType::MYSQL_TYPE_LONGLONG => "BIGINT",
        ColumnType::MYSQL_TYPE_INT24 => "MEDIUMINT",
        ColumnType::MYSQL_TYPE_DATE => "DATE",
        ColumnType::MYSQL_TYPE_TIME => "TIME",
        ColumnType::MYSQL_TYPE_DATETIME => "DATETIME",
        ColumnType::MYSQL_TYPE_YEAR => "YEAR",
        ColumnType::MYSQL_TYPE_NEWDATE => "DATE",
        ColumnType::MYSQL_TYPE_VARCHAR => "VARCHAR",
        ColumnType::MYSQL_TYPE_BIT => "BIT",
        ColumnType::MYSQL_TYPE_JSON => "JSON",
        ColumnType::MYSQL_TYPE_ENUM => "ENUM",
        ColumnType::MYSQL_TYPE_SET => "SET",
        ColumnType::MYSQL_TYPE_TINY_BLOB => "TINYBLOB",
        ColumnType::MYSQL_TYPE_MEDIUM_BLOB => "MEDIUMBLOB",
        ColumnType::MYSQL_TYPE_LONG_BLOB => "LONGBLOB",
        ColumnType::MYSQL_TYPE_BLOB => "BLOB",
        ColumnType::MYSQL_TYPE_VAR_STRING => "VAR_STRING",
        ColumnType::MYSQL_TYPE_STRING => "CHAR",
        ColumnType::MYSQL_TYPE_GEOMETRY => "GEOMETRY",
        _ => "UNKNOWN",
    }
}

fn is_binary(column: &Column) -> bool {
    // TEXT/BLOB share the same MySQL type; the charset (63 = binary) is what
    // distinguishes a real binary payload from text. Numeric columns also carry
    // BINARY_FLAG, so flags alone must not be used here.
    column.character_set() == 63
        && matches!(
            column.column_type(),
            ColumnType::MYSQL_TYPE_TINY_BLOB
                | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                | ColumnType::MYSQL_TYPE_LONG_BLOB
                | ColumnType::MYSQL_TYPE_BLOB
                | ColumnType::MYSQL_TYPE_STRING
                | ColumnType::MYSQL_TYPE_VAR_STRING
                | ColumnType::MYSQL_TYPE_VARCHAR
                | ColumnType::MYSQL_TYPE_GEOMETRY
                | ColumnType::MYSQL_TYPE_BIT
        )
}

pub fn serialize_value(value: Option<&Value>, column: Option<&Column>) -> Json {
    let Some(value) = value else { return Json::Null };
    match value {
        Value::NULL => Json::Null,
        Value::Bytes(bytes) => {
            if column.map(is_binary).unwrap_or(false) {
                return json!({
                    "__finchType": "blob",
                    "size": bytes.len(),
                    "preview": bytes.iter().take(32).map(|b| format!("{b:02x}")).collect::<String>(),
                });
            }
            let text = String::from_utf8_lossy(bytes).to_string();
            if let Some(column) = column {
                match column.column_type() {
                    ColumnType::MYSQL_TYPE_TINY
                    | ColumnType::MYSQL_TYPE_SHORT
                    | ColumnType::MYSQL_TYPE_LONG
                    | ColumnType::MYSQL_TYPE_LONGLONG
                    | ColumnType::MYSQL_TYPE_INT24
                    | ColumnType::MYSQL_TYPE_YEAR => {
                        if let Ok(value) = text.parse::<i64>() {
                            return json!(value);
                        }
                        if let Ok(value) = text.parse::<u64>() {
                            return json!(value);
                        }
                    }
                    ColumnType::MYSQL_TYPE_FLOAT | ColumnType::MYSQL_TYPE_DOUBLE => {
                        if let Ok(value) = text.parse::<f64>() {
                            return json!(value);
                        }
                    }
                    _ => {}
                }
            }
            Json::String(text)
        }
        Value::Int(v) => {
            if v.abs() > 9_007_199_254_740_991 {
                Json::String(v.to_string())
            } else {
                json!(v)
            }
        }
        Value::UInt(v) => {
            if *v > 9_007_199_254_740_991 {
                Json::String(v.to_string())
            } else {
                json!(v)
            }
        }
        Value::Float(v) => json!(v),
        Value::Double(v) => json!(v),
        Value::Date(y, m, d, h, mi, s, us) => {
            if *us == 0 {
                Json::String(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
            } else {
                Json::String(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"))
            }
        }
        Value::Time(neg, days, h, mi, s, us) => {
            let sign = if *neg { "-" } else { "" };
            Json::String(format!("{sign}{days} {h:02}:{mi:02}:{s:02}.{us:06}"))
        }
    }
}

pub fn serialize_columns(columns: &[Column]) -> Vec<ResultColumn> {
    columns
        .iter()
        .map(|c| ResultColumn {
            name: c.name_str().to_string(),
            org_name: c.org_name_str().to_string(),
            table: c.table_str().to_string(),
            database: c.schema_str().to_string(),
            column_type: column_type_name(c.column_type()).to_string(),
            length: c.column_length() as u64,
            flags: c.flags().bits(),
            decimals: c.decimals(),
        })
        .collect()
}

pub fn serialize_row(row: &Row) -> Vec<Json> {
    let columns = row.columns_ref();
    (0..row.len())
        .map(|index| serialize_value(row.as_ref(index), columns.get(index)))
        .collect()
}

pub fn mysql_to_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::NULL) => String::new(),
        Some(Value::Bytes(bytes)) => String::from_utf8_lossy(bytes).to_string(),
        Some(Value::Int(v)) => v.to_string(),
        Some(Value::UInt(v)) => v.to_string(),
        Some(Value::Float(v)) => v.to_string(),
        Some(Value::Double(v)) => v.to_string(),
        Some(Value::Date(y, m, d, h, mi, s, _)) => format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}"),
        Some(Value::Time(_, d, h, mi, s, _)) => format!("{d} {h:02}:{mi:02}:{s:02}"),
    }
}

pub use crate::sql::{first_keyword, split_statements};
