use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub color: String,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_user")]
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssl_mode: String,
    #[serde(default)]
    pub ssl_ca_path: String,
    #[serde(default)]
    pub ssl_cert_path: String,
    #[serde(default)]
    pub ssl_key_path: String,
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default = "default_ssh_auth")]
    pub ssh_auth: String,
    #[serde(default)]
    pub ssh_key_path: String,
    #[serde(default = "default_keepalive")]
    pub keep_alive_seconds: u64,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(default = "default_timeout")]
    pub connect_timeout: u64,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub last_connected_at: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub has_ssh_password: bool,
}

fn default_host() -> String { "127.0.0.1".into() }
fn default_port() -> u16 { 3306 }
fn default_user() -> String { "root".into() }
fn default_ssh_port() -> u16 { 22 }
fn default_ssh_auth() -> String { "key".into() }
fn default_keepalive() -> u64 { 30 }
fn default_timeout() -> u64 { 10000 }
fn default_true() -> bool { true }

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionInput {
    #[serde(flatten)]
    pub connection: ConnectionProfile,
    pub password: Option<String>,
    pub ssh_password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionInput {
    #[serde(flatten)]
    pub connection: ConnectionProfile,
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub status: String,
    pub version: String,
    pub server: serde_json::Value,
    pub latency: Option<u64>,
    pub connected_at: i64,
    pub reconnect_attempts: Option<u32>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub charset: String,
    pub collation: String,
    pub is_system: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub table_type: String,
    pub engine: Option<String>,
    pub row_estimate: Option<i64>,
    pub comment: String,
    pub data_length: u64,
    pub index_length: u64,
    pub collation: Option<String>,
    pub create_time: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub column_type: String,
    pub data_type: String,
    pub nullable: String,
    pub default_value: Option<String>,
    pub extra: String,
    pub column_key: String,
    pub comment: String,
    pub position: i64,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub generation_expression: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub column: String,
    pub unique: bool,
    pub sequence: i64,
    pub cardinality: Option<i64>,
    #[serde(rename = "type")]
    pub index_type: String,
    pub nullable: bool,
    pub comment: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column_name: String,
    pub ref_database: String,
    pub ref_table: String,
    pub ref_column: String,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub timing: String,
    pub statement: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub triggers: Vec<TriggerInfo>,
    pub ddl: String,
    pub primary_keys: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub org_name: String,
    pub table: String,
    pub database: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub length: u64,
    pub flags: u16,
    pub decimals: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub message: String,
    pub code: String,
    pub errno: u32,
    pub sql_state: String,
    pub sql: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub kind: String,
    pub sql: String,
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    #[serde(default)]
    pub truncated: bool,
    /// `rows` when the row cap was hit, `bytes` when the payload budget was hit.
    #[serde(default)]
    pub truncated_reason: Option<String>,
    pub duration_ms: u64,
    #[serde(default)]
    pub affected_rows: u64,
    #[serde(default)]
    pub insert_id: Option<String>,
    #[serde(default)]
    pub changed_rows: u64,
    #[serde(default)]
    pub info: String,
    #[serde(default)]
    pub warnings: u16,
    #[serde(default)]
    pub error: Option<QueryError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub execution_id: String,
    pub statements: Vec<StatementResult>,
    pub duration_ms: u64,
    #[serde(default)]
    pub cancelled: bool,
    pub server_version: String,
    pub database: String,
    pub thread_id: u32,
    pub timings: QueryTimings,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTimings {
    pub connection_ms: u64,
    pub prepare_ms: u64,
    pub execution_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryPayload {
    pub session_id: String,
    pub sql: String,
    pub database: String,
    pub execution_id: String,
    pub max_rows: Option<usize>,
    pub auto_limit: Option<bool>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub prod_confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    pub column: String,
    pub op: String,
    pub value: String,
    #[serde(default)]
    pub value2: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDataPayload {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub limit: usize,
    pub offset: usize,
    pub filters: Vec<TableFilter>,
    pub search: String,
    pub order_by: Option<String>,
    pub order_dir: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableData {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total: Option<u64>,
    pub limit: usize,
    pub offset: usize,
    pub primary_keys: Vec<String>,
    pub column_meta: Vec<ColumnInfo>,
    pub order_by: Option<String>,
    pub order_dir: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellPayload {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub column: String,
    pub value: serde_json::Value,
    pub keys: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub prod_confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsPayload {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub prod_confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowPayload {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub values: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: u64,
    pub user: String,
    pub host: String,
    pub db: Option<String>,
    pub command: String,
    pub time: u64,
    pub state: Option<String>,
    pub info: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub uptime: u64,
    pub threads_connected: u64,
    pub threads_running: u64,
    pub queries: u64,
    pub slow_queries: u64,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub aborted_connects: u64,
    pub max_used_connections: u64,
    pub qps_avg: f64,
    pub questions: u64,
    pub innodb_buffer_pool_size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerOverview {
    pub version: String,
    pub variables: std::collections::HashMap<String, String>,
    pub status: ServerStatus,
    pub database_stats: serde_json::Value,
    pub top_tables: Vec<serde_json::Value>,
    pub processes: Vec<ProcessInfo>,
    pub replication: Option<serde_json::Value>,
    pub sampled_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub sql: String,
    pub duration_ms: u64,
    pub statement_count: usize,
    pub row_count: usize,
    pub success: bool,
    pub error: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub show_system_schemas: bool,
    pub max_rows: usize,
    pub confirm_destructive: bool,
    pub auto_limit_selects: bool,
    pub editor_font_size: u32,
    pub grid_density: String,
    pub zoom_factor: f64,
    #[serde(default)]
    pub ui_font: String,
    #[serde(default)]
    pub mono_font: String,
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: u32,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_motion")]
    pub motion: String,
    pub last_connection_id: Option<String>,
    #[serde(default = "default_query_timeout")]
    pub query_timeout_seconds: u32,
}

fn default_query_timeout() -> u32 {
    60
}

fn default_ui_font_size() -> u32 {
    13
}

fn default_accent_color() -> String {
    "#5068f0".into()
}

fn default_motion() -> String {
    "full".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            show_system_schemas: false,
            max_rows: 5000,
            confirm_destructive: true,
            auto_limit_selects: true,
            editor_font_size: 13,
            grid_density: "comfortable".into(),
            zoom_factor: 1.0,
            ui_font: String::new(),
            mono_font: String::new(),
            ui_font_size: default_ui_font_size(),
            accent_color: default_accent_color(),
            motion: default_motion(),
            last_connection_id: None,
            query_timeout_seconds: default_query_timeout(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    /// Wire protocol: `chat` (/chat/completions), `responses` (/responses),
    /// or `anthropic` (/messages).
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub has_key: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInput {
    pub provider: AiProvider,
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateInput {
    pub request_id: String,
    pub session_id: String,
    pub database: String,
    pub prompt: String,
    pub provider_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncTable {
    pub name: String,
    pub mode: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub source_id: String,
    pub target_id: String,
    pub source_database: String,
    pub target_database: String,
    pub tables: Vec<SyncTable>,
    pub create_missing: bool,
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub concurrency: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncTableResult {
    pub table: String,
    pub created: bool,
    pub read: u64,
    pub written: u64,
    pub skipped_columns: Vec<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub shards: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub tables: Vec<SyncTableResult>,
    pub created_tables: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DdlColumn {
    pub name: String,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub auto_increment: bool,
    pub primary: bool,
    pub comment: String,
    pub after: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DdlIndex {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub unique: bool,
    /// BTREE (default), HASH, FULLTEXT or SPATIAL.
    #[serde(default)]
    pub index_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableRequest {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub columns: Vec<DdlColumn>,
    pub engine: String,
    pub charset: String,
    #[serde(default)]
    pub indexes: Vec<DdlIndex>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AlterTableRequest {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub add: Vec<DdlColumn>,
    pub modify: Vec<DdlColumn>,
    pub drop_columns: Vec<String>,
    pub rename_to: Option<String>,
    #[serde(default)]
    pub add_indexes: Vec<DdlIndex>,
    #[serde(default)]
    pub modify_indexes: Vec<DdlIndex>,
    #[serde(default)]
    pub drop_indexes: Vec<String>,
    #[serde(default)]
    pub prod_confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DumpRequest {
    pub session_id: String,
    pub database: String,
    pub path: String,
    pub structure: bool,
    pub data: bool,
    pub tables: Vec<String>,
    #[serde(default)]
    pub split_files: bool,
}
