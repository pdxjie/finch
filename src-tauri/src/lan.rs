//! Peer-to-peer transfer over the local network.
//!
//! Discovery uses a UDP beacon. Data runs over a mutually authenticated TLS
//! channel: the server presents a self-signed certificate, the client pins the
//! certificate advertised by that peer and only sessions explicitly accepted by
//! the other side are allowed. Passwords never leave the machine: each side
//! executes reads/writes against its own MySQL connection.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use mysql_async::prelude::*;
use mysql_async::Params;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::db::{self, AppState};
use crate::schema;

const DISCOVERY_PORT: u16 = 45830;
const FRAME_JSON: u8 = 1;
const FRAME_DATA: u8 = 2;
const MAX_FRAME: usize = 8 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;
const BATCH_ROWS: usize = 200;

type BoxReader = Box<dyn AsyncRead + Unpin + Send>;
type BoxWriter = Box<dyn AsyncWrite + Unpin + Send>;

pub struct LanState {
    runtime: Mutex<Option<Arc<Runtime>>>,
    enabled: AtomicBool,
    device_name: Mutex<String>,
    peers: Mutex<HashMap<String, Peer>>,
    requests: Mutex<HashMap<String, Pending>>,
    sessions: Mutex<HashMap<String, Arc<LanSession>>>,
}

struct Runtime {
    port: u16,
    cert: Vec<u8>,
    key: Vec<u8>,
    id: String,
}

#[derive(Clone)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub cert: Vec<u8>,
    seen: Instant,
}

struct Pending {
    tx: oneshot::Sender<Decision>,
}

pub struct Decision {
    pub accept: bool,
    pub connection_id: String,
    pub database: String,
    pub download_dir: String,
}

pub struct LanSession {
    pub id: String,
    pub peer_name: String,
    pub peer_connection: String,
    pub peer_database: String,
    pub my_connection_id: String,
    pub my_database: String,
    pub download_dir: String,
    writer: AsyncMutex<BoxWriter>,
    closed: AtomicBool,
}

struct IncomingFile {
    file: tokio::fs::File,
    hasher: Sha256,
    received: u64,
    total: u64,
    name: String,
    path: PathBuf,
}

struct TableImport {
    table: String,
    source_columns: Vec<String>,
    common: Vec<String>,
    primary_keys: Vec<String>,
}

#[derive(Deserialize)]
struct RequestFrame {
    #[serde(rename = "deviceName")]
    device_name: String,
    #[serde(rename = "connectionName")]
    connection_name: String,
    database: String,
}

impl LanState {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
            enabled: AtomicBool::new(false),
            device_name: Mutex::new(hostname()),
            peers: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_device_name(&self, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("设备名不能为空".into());
        }
        *self.device_name.lock().unwrap() = name.chars().take(48).collect();
        Ok(())
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub async fn start(&self, app: &AppHandle) -> Result<Json, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        self.set_enabled(true);
        if self.runtime.lock().unwrap().is_some() {
            return Ok(self.status());
        }
        let key = rcgen::generate_simple_self_signed(vec!["finch.local".to_string()])
            .map_err(|error| format!("生成局域网证书失败: {error}"))?;
        let cert = key.cert.der().to_vec();
        let key_der = key.key_pair.serialize_der();
        let id = uuid::Uuid::new_v4().to_string();
        let listener = TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|error| format!("无法监听局域网端口: {error}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let runtime = Arc::new(Runtime { port, cert, key: key_der, id });
        *self.runtime.lock().unwrap() = Some(runtime.clone());

        let acceptor = Arc::new(
            ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(runtime.cert.clone())],
                    PrivateKeyDer::Pkcs8(runtime.key.clone().into()),
                )
                .map_err(|error| format!("TLS 配置失败: {error}"))?,
        );
        {
            let app = app.clone();
            let acceptor = TlsAcceptor::from(acceptor);
            tauri::async_runtime::spawn(async move {
                loop {
                    let Ok((stream, address)) = listener.accept().await else { break };
                    let app = app.clone();
                    let acceptor = acceptor.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_server(app, stream, address, acceptor).await;
                    });
                }
            });
        }
        {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                discovery_loop(app).await;
            });
        }
        Ok(self.status())
    }

    pub fn stop(&self) {
        self.set_enabled(false);
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.closed.store(true, Ordering::Relaxed);
            }
        }
        self.peers.lock().unwrap().clear();
    }

    pub fn status(&self) -> Json {
        let now = Instant::now();
        let peers: Vec<Json> = self
            .peers
            .lock()
            .unwrap()
            .values()
            .filter(|peer| now.duration_since(peer.seen) < Duration::from_secs(10))
            .map(|peer| {
                json!({
                    "id": peer.id,
                    "name": peer.name,
                    "address": peer.address,
                    "port": peer.port,
                })
            })
            .collect();
        let sessions: Vec<Json> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| {
                json!({
                    "id": session.id,
                    "peerName": session.peer_name,
                    "peerConnection": session.peer_connection,
                    "peerDatabase": session.peer_database,
                    "myConnectionId": session.my_connection_id,
                    "myDatabase": session.my_database,
                    "downloadDir": session.download_dir,
                })
            })
            .collect();
        let (port, id, cert) = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .map(|runtime| {
                (
                    runtime.port,
                    runtime.id.clone(),
                    base64::engine::general_purpose::STANDARD.encode(&runtime.cert),
                )
            })
            .unwrap_or((0, String::new(), String::new()));
        json!({
            "enabled": self.is_enabled(),
            "deviceName": self.device_name.lock().unwrap().clone(),
            "deviceId": id,
            "port": port,
            "cert": cert,
            "peers": peers,
            "sessions": sessions,
        })
    }

    pub async fn connect(
        &self,
        app: &AppHandle,
        peer_id: &str,
        connection_id: &str,
        database: &str,
    ) -> Result<Json, String> {
        let peer = self
            .peers
            .lock()
            .unwrap()
            .get(peer_id)
            .cloned()
            .ok_or_else(|| "对方已离线".to_string())?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let state = app.state::<AppState>();
        let profile = state
            .profiles
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == connection_id)
            .cloned()
            .ok_or_else(|| "连接不存在".to_string())?;
        if profile.category == "prod" {
            return Err("生产连接不允许用于局域网传输".into());
        }
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(peer.cert.clone()))
            .map_err(|error| format!("证书无效: {error}"))?;
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let stream = TcpStream::connect((peer.address.as_str(), peer.port))
            .await
            .map_err(|error| format!("无法连接对方: {error}"))?;
        let name = ServerName::try_from("finch.local").map_err(|e| e.to_string())?;
        let tls = TlsConnector::from(Arc::new(config))
            .connect(name, stream)
            .await
            .map_err(|error| format!("加密握手失败: {error}"))?;
        let (mut reader, mut writer) = tokio::io::split(tls);
        write_json(
            &mut writer,
            &json!({
                "type": "request",
                "deviceName": self.device_name.lock().unwrap().clone(),
                "connectionName": profile.name,
                "database": database,
            }),
        )
        .await?;
        let response = read_json(&mut reader).await?;
        if response["type"] != "accepted" {
            return Err(response["message"].as_str().unwrap_or("对方拒绝了连接").to_string());
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(LanSession {
            id: session_id.clone(),
            peer_name: peer.name,
            peer_connection: response["connectionName"].as_str().unwrap_or("").into(),
            peer_database: response["database"].as_str().unwrap_or("").into(),
            my_connection_id: connection_id.into(),
            my_database: database.into(),
            download_dir: response["downloadDir"].as_str().unwrap_or("").into(),
            writer: AsyncMutex::new(Box::new(writer)),
            closed: AtomicBool::new(false),
        });
        self.sessions.lock().unwrap().insert(session_id.clone(), session.clone());
        {
            let app = app.clone();
            let session = session.clone();
            tauri::async_runtime::spawn(async move {
                session_reader(Box::new(reader), app, session).await;
            });
        }
        Ok(json!({
            "id": session_id,
            "peerName": session.peer_name,
            "peerConnection": session.peer_connection,
            "peerDatabase": session.peer_database,
            "myConnectionId": session.my_connection_id,
            "myDatabase": session.my_database,
            "downloadDir": session.download_dir,
        }))
    }

    pub fn respond(
        &self,
        request_id: &str,
        accept: bool,
        connection_id: &str,
        database: &str,
        download_dir: &str,
    ) -> Result<(), String> {
        let pending = self
            .requests
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| "请求已过期".to_string())?;
        pending
            .tx
            .send(Decision {
                accept,
                connection_id: connection_id.into(),
                database: database.into(),
                download_dir: download_dir.into(),
            })
            .map_err(|_| "请求已断开".to_string())
    }

    pub fn session(&self, id: &str) -> Result<Arc<LanSession>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())
    }

    pub fn disconnect(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            session.closed.store(true, Ordering::Relaxed);
        }
    }

    pub async fn send_file(&self, app: &AppHandle, session_id: &str, path: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        let path = PathBuf::from(path);
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| format!("无法读取文件: {error}"))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_string();
        let size = metadata.len();
        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|error| format!("无法读取文件: {error}"))?;
        let mut writer = session.writer.lock().await;
        write_json(
            &mut *writer,
            &json!({"type":"file_start","name":name,"size":size}),
        )
        .await?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; CHUNK];
        let mut sent = 0u64;
        loop {
            let read = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            write_data(&mut *writer, &buffer[..read]).await?;
            sent += read as u64;
            emit_progress(app, session_id, "file", &name, sent, size);
        }
        let digest = hex::encode(hasher.finalize());
        write_json(
            &mut *writer,
            &json!({"type":"file_end","sha256":digest,"size":size}),
        )
        .await?;
        drop(writer);
        Ok(())
    }

    pub async fn send_tables(
        &self,
        app: &AppHandle,
        session_id: &str,
        tables: Vec<String>,
        structure: bool,
        data: bool,
    ) -> Result<(), String> {
        let session = self.session(session_id)?;
        let state = app.state::<AppState>();
        let source = state.session(&session.my_connection_id)?;
        let database = session.my_database.clone();
        for (index, table) in tables.iter().enumerate() {
            if session.closed.load(Ordering::Relaxed) {
                return Err("会话已断开".into());
            }
            let details = schema::get_table_details(&state, &session.my_connection_id, &database, table).await?;
            let columns: Vec<String> = details.columns.iter().map(|column| column.name.clone()).collect();
            {
                let mut writer = session.writer.lock().await;
                write_json(
                    &mut *writer,
                    &json!({
                        "type": "table_start",
                        "table": table,
                        "sourceDatabase": database,
                        "columns": columns,
                        "primaryKeys": details.primary_keys,
                        "ddl": details.ddl,
                        "structure": structure,
                        "data": data,
                        "index": index,
                        "total": tables.len(),
                    }),
                )
                .await?;
            }
            if data {
                let mut conn = source.pool.get_conn().await.map_err(|e| e.to_string())?;
                let mut result = conn
                    .query_iter(format!("SELECT * FROM {}", crate::db::qualify(&database, table)))
                    .await
                    .map_err(|e| e.to_string())?;
                let mut rows: Vec<Vec<Json>> = Vec::with_capacity(BATCH_ROWS);
                let mut sent = 0usize;
                while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
                    rows.push(db::serialize_row(&row));
                    if rows.len() >= BATCH_ROWS {
                        let mut writer = session.writer.lock().await;
                        write_json(&mut *writer, &json!({"type":"rows","rows":rows})).await?;
                        drop(writer);
                        sent += rows.len();
                        rows.clear();
                        emit_progress(app, session_id, "table", table, sent as u64, 0);
                    }
                }
                if !rows.is_empty() {
                    let mut writer = session.writer.lock().await;
                    write_json(&mut *writer, &json!({"type":"rows","rows":rows})).await?;
                }
            }
            let mut writer = session.writer.lock().await;
            write_json(&mut *writer, &json!({"type":"table_end","table":table})).await?;
            drop(writer);
            emit_progress(app, session_id, "table", table, 1, 1);
        }
        Ok(())
    }
}

async fn discovery_loop(app: AppHandle) {
    let port = std::env::var("FINCH_LAN_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DISCOVERY_PORT);
    let Ok(socket) = UdpSocket::bind(("0.0.0.0", port)).await else { return };
    let _ = socket.set_broadcast(true);
    let mut buffer = [0u8; 4096];
    let lan = app.state::<AppState>().lan.clone();
    loop {
        let enabled = lan.is_enabled();
        let runtime = lan.runtime.lock().unwrap().clone();
        if enabled {
            if let Some(runtime) = runtime.as_ref() {
                let payload = json!({
                    "id": runtime.id,
                    "name": lan.device_name.lock().unwrap().clone(),
                    "port": runtime.port,
                    "cert": base64::engine::general_purpose::STANDARD.encode(&runtime.cert),
                })
                .to_string();
                let _ = socket.send_to(payload.as_bytes(), ("255.255.255.255", port)).await;
            }
        }
        let received = tokio::time::timeout(Duration::from_secs(2), socket.recv_from(&mut buffer)).await;
        if let Ok(Ok((length, address))) = received {
            if let Ok(value) = serde_json::from_slice::<Json>(&buffer[..length]) {
                let id = value["id"].as_str().unwrap_or_default().to_string();
                if id.is_empty() {
                    continue;
                }
                let own_id = lan
                    .runtime
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|runtime| runtime.id.clone())
                    .unwrap_or_default();
                if id == own_id {
                    continue;
                }
                let Ok(cert) = base64::engine::general_purpose::STANDARD.decode(
                    value["cert"].as_str().unwrap_or_default(),
                ) else {
                    continue;
                };
                lan.peers.lock().unwrap().insert(
                    id.clone(),
                    Peer {
                        id,
                        name: value["name"].as_str().unwrap_or("Finch").into(),
                        address: address.ip().to_string(),
                        port: value["port"].as_u64().unwrap_or(0) as u16,
                        cert,
                        seen: Instant::now(),
                    },
                );
            }
        }
        if let Ok(mut peers) = lan.peers.lock() {
            let now = Instant::now();
            peers.retain(|_, peer| now.duration_since(peer.seen) < Duration::from_secs(12));
        }
    }
}

async fn handle_server(
    app: AppHandle,
    stream: TcpStream,
    _address: std::net::SocketAddr,
    acceptor: TlsAcceptor,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !state.lan.is_enabled() {
        return Ok(());
    }
    let tls = acceptor.accept(stream).await.map_err(|e| e.to_string())?;
    let (mut reader, mut writer) = tokio::io::split(tls);
    let request = match read_json(&mut reader).await {
        Ok(value) if value["type"] == "request" => value,
        _ => return Ok(()),
    };
    let frame: RequestFrame = serde_json::from_value(request.clone()).map_err(|e| e.to_string())?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.lan.requests.lock().unwrap().insert(
        request_id.clone(),
        Pending { tx },
    );
    let _ = app.emit(
        "finch://event",
        json!({
            "type": "lan:request",
            "id": request_id,
            "peerName": frame.device_name,
            "connectionName": frame.connection_name,
            "database": frame.database,
        }),
    );
    let decision = match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(decision)) => decision,
        _ => {
            state.lan.requests.lock().unwrap().remove(&request_id);
            write_json(&mut writer, &json!({"type":"rejected","message":"请求超时"})).await?;
            return Ok(());
        }
    };
    if !decision.accept {
        write_json(&mut writer, &json!({"type":"rejected","message":"对方拒绝了请求"})).await?;
        return Ok(());
    }
    let profile = state
        .profiles
        .lock()
        .unwrap()
        .iter()
        .find(|item| item.id == decision.connection_id)
        .cloned()
        .ok_or_else(|| "连接不存在".to_string())?;
    if profile.category == "prod" {
        write_json(&mut writer, &json!({"type":"rejected","message":"生产连接不允许传输"})).await?;
        return Ok(());
    }
    let download_dir = decision.download_dir.clone();
    let _ = tokio::fs::create_dir_all(&download_dir).await;
    write_json(
        &mut writer,
        &json!({
            "type": "accepted",
            "connectionName": profile.name,
            "database": decision.database,
            "downloadDir": download_dir,
        }),
    )
    .await?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(LanSession {
        id: session_id.clone(),
        peer_name: frame.device_name,
        peer_connection: frame.connection_name,
        peer_database: frame.database,
        my_connection_id: profile.id,
        my_database: decision.database,
        download_dir: decision.download_dir,
        writer: AsyncMutex::new(Box::new(writer)),
        closed: AtomicBool::new(false),
    });
    state.lan.sessions.lock().unwrap().insert(session_id.clone(), session.clone());
    let _ = app.emit(
        "finch://event",
        json!({"type":"lan:session","session": session_json(&session)}),
    );
    session_reader(Box::new(reader), app, session).await;
    Ok(())
}

async fn session_reader(mut reader: BoxReader, app: AppHandle, session: Arc<LanSession>) {
    let mut file: Option<IncomingFile> = None;
    let mut table: Option<TableImport> = None;
    while !session.closed.load(Ordering::Relaxed) {
        let frame = match read_frame(&mut reader).await {
            Some(frame) => frame,
            None => break,
        };
        match frame {
            Frame::Json(value) => {
                let kind = value["type"].as_str().unwrap_or_default();
                match kind {
                    "file_start" => {
                        let name = value["name"].as_str().unwrap_or("file").to_string();
                        let total = value["size"].as_u64().unwrap_or(0);
                        let path = unique_path(&session.download_dir, &name).await;
                        if let Ok(handle) = tokio::fs::File::create(&path).await {
                            file = Some(IncomingFile {
                                file: handle,
                                hasher: Sha256::new(),
                                received: 0,
                                total,
                                name: name.clone(),
                                path,
                            });
                            emit_progress(&app, &session.id, "file", &name, 0, total);
                        }
                    }
                    "file_end" => {
                        if let Some(mut incoming) = file.take() {
                            let _ = incoming.file.flush().await;
                            let digest = hex::encode(incoming.hasher.finalize());
                            let expected = value["sha256"].as_str().unwrap_or_default();
                            if expected.is_empty() || digest == expected {
                                emit_progress(&app, &session.id, "done", &incoming.name, incoming.total, incoming.total);
                            } else {
                                emit_progress(&app, &session.id, "error", &incoming.name, incoming.received, incoming.total);
                                let _ = tokio::fs::remove_file(&incoming.path).await;
                            }
                        }
                    }
                    "table_start" => {
                        match prepare_table(&app, &session, &value).await {
                            Ok(prepared) => table = prepared,
                            Err(error) => {
                                eprintln!("lan table_start failed: {error}");
                                emit_error(&app, &session.id, &error);
                            }
                        }
                    }
                    "rows" => {
                        if let Some(current) = table.as_ref() {
                            if let Some(rows) = value["rows"].as_array() {
                                if let Err(error) = apply_rows(&app, &session, current, rows).await {
                                    eprintln!("lan rows failed: {error}");
                                    emit_error(&app, &session.id, &error);
                                }
                            }
                        }
                    }
                    "table_end" => {
                        if let Some(current) = table.take() {
                            emit_progress(&app, &session.id, "table-done", &current.table, 1, 1);
                        }
                    }
                    "ping" => {}
                    _ => {}
                }
            }
            Frame::Data(data) => {
                if let Some(incoming) = file.as_mut() {
                    if incoming.file.write_all(&data).await.is_ok() {
                        incoming.hasher.update(&data);
                        incoming.received += data.len() as u64;
                        emit_progress(
                            &app,
                            &session.id,
                            "file",
                            &incoming.name,
                            incoming.received,
                            incoming.total,
                        );
                    }
                }
            }
        }
    }
    session.closed.store(true, Ordering::Relaxed);
    let _ = app.emit(
        "finch://event",
        json!({"type":"lan:closed","sessionId": session.id}),
    );
}

async fn prepare_table(
    app: &AppHandle,
    session: &LanSession,
    value: &Json,
) -> Result<Option<TableImport>, String> {
    let table = value["table"].as_str().unwrap_or_default().to_string();
    if table.is_empty() {
        return Ok(None);
    }
    let state = app.state::<AppState>();
    let conn = state.session(&session.my_connection_id)?;
    let database = session.my_database.clone();
    let source_columns: Vec<String> = value["columns"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let structure = value["structure"].as_bool().unwrap_or(false);
    let mut pool = conn.pool.get_conn().await.map_err(|e| e.to_string())?;
    pool.query_drop(format!("USE {}", crate::db::quote_id(&database)))
        .await
        .map_err(|e| e.to_string())?;
    if structure {
        let ddl = value["ddl"].as_str().unwrap_or_default();
        if !ddl.is_empty() {
            let exists: Option<u8> = pool
                .query_first(format!(
                    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'",
                    table.replace('\'', "''")
                ))
                .await
                .map_err(|e| e.to_string())?;
            if exists.is_none() {
                let create = ddl.replacen("CREATE TABLE", "CREATE TABLE IF NOT EXISTS", 1);
                pool.query_drop(create).await.map_err(|e| e.to_string())?;
            }
        }
    }
    let rows = pool
        .query::<mysql_async::Row, _>(format!(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' ORDER BY ORDINAL_POSITION",
            table.replace('\'', "''")
        ))
        .await
        .map_err(|e| e.to_string())?;
    let target_columns: Vec<String> = rows.iter().filter_map(|row| row.get::<String, _>(0)).collect();
    let common: Vec<String> = source_columns
        .iter()
        .filter(|column| target_columns.contains(column))
        .cloned()
        .collect();
    if common.is_empty() {
        return Ok(None);
    }
    let primary_keys = value["primaryKeys"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Ok(Some(TableImport {
        table,
        source_columns,
        common,
        primary_keys,
    }))
}

async fn apply_rows(
    app: &AppHandle,
    session: &LanSession,
    table: &TableImport,
    rows: &[Json],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let state = app.state::<AppState>();
    let conn = state.session(&session.my_connection_id)?;
    let mut pool = conn.pool.get_conn().await.map_err(|e| e.to_string())?;
    pool.query_drop(format!("USE {}", crate::db::quote_id(&session.my_database)))
        .await
        .map_err(|e| e.to_string())?;
    let indexes: Vec<usize> = table
        .common
        .iter()
        .map(|column| table.source_columns.iter().position(|item| item == column).unwrap_or(0))
        .collect();
    let names = table.common.iter().map(|column| crate::db::quote_id(column)).collect::<Vec<_>>().join(", ");
    let placeholders = (0..rows.len())
        .map(|_| format!("({})", vec!["?"; table.common.len()].join(", ")))
        .collect::<Vec<_>>()
        .join(", ");
    let updates = table
        .common
        .iter()
        .filter(|column| !table.primary_keys.contains(column))
        .map(|column| format!("{}=VALUES({})", crate::db::quote_id(column), crate::db::quote_id(column)))
        .collect::<Vec<_>>();
    let tail = if updates.is_empty() {
        String::new()
    } else {
        format!(" ON DUPLICATE KEY UPDATE {}", updates.join(", "))
    };
    let sql = format!(
        "INSERT INTO {}.{} ({names}) VALUES {placeholders}{tail}",
        crate::db::quote_id(&session.my_database),
        crate::db::quote_id(&table.table)
    );
    let mut params = Vec::with_capacity(rows.len() * indexes.len());
    for row in rows {
        let values = row.as_array().ok_or_else(|| "行数据格式错误".to_string())?;
        for index in &indexes {
            params.push(db::json_to_mysql(&values[*index]));
        }
    }
    pool.exec_drop(sql, Params::Positional(params))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_error(app: &AppHandle, session_id: &str, message: &str) {
    let _ = app.emit(
        "finch://event",
        json!({"type":"lan:progress","sessionId": session_id, "kind":"error", "name": message, "done":0, "total":0}),
    );
}

fn emit_progress(app: &AppHandle, session_id: &str, kind: &str, name: &str, done: u64, total: u64) {
    let _ = app.emit(
        "finch://event",
        json!({
            "type": "lan:progress",
            "sessionId": session_id,
            "kind": kind,
            "name": name,
            "done": done,
            "total": total,
        }),
    );
}

fn session_json(session: &LanSession) -> Json {
    json!({
        "id": session.id,
        "peerName": session.peer_name,
        "peerConnection": session.peer_connection,
        "peerDatabase": session.peer_database,
        "myConnectionId": session.my_connection_id,
        "myDatabase": session.my_database,
        "downloadDir": session.download_dir,
    })
}

async fn unique_path(dir: &str, name: &str) -> PathBuf {
    let base = Path::new(dir);
    let _ = tokio::fs::create_dir_all(base).await;
    let safe = name.replace('/', "_").replace('\\', "_");
    let path = base.join(&safe);
    if tokio::fs::metadata(&path).await.is_err() {
        return path;
    }
    let stem = Path::new(&safe)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let ext = Path::new(&safe).extension().and_then(|value| value.to_str());
    for index in 1..10000 {
        let candidate = match ext {
            Some(ext) => base.join(format!("{stem} ({index}).{ext}")),
            None => base.join(format!("{stem} ({index})")),
        };
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
    }
    path
}

enum Frame {
    Json(Json),
    Data(Vec<u8>),
}

async fn write_json(writer: &mut (impl AsyncWrite + Unpin), value: &Json) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    write_frame(writer, FRAME_JSON, &bytes).await
}

async fn write_data(writer: &mut (impl AsyncWrite + Unpin), data: &[u8]) -> Result<(), String> {
    write_frame(writer, FRAME_DATA, data).await
}

async fn write_frame(
    writer: &mut (impl AsyncWrite + Unpin),
    kind: u8,
    data: &[u8],
) -> Result<(), String> {
    if data.len() > MAX_FRAME {
        return Err("数据帧过大".into());
    }
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(data.len() as u32).to_be_bytes());
    writer.write_all(&header).await.map_err(|e| e.to_string())?;
    writer.write_all(data).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}

async fn read_frame(reader: &mut BoxReader) -> Option<Frame> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header).await.ok()?;
    let kind = header[0];
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if length > MAX_FRAME {
        return None;
    }
    let mut data = vec![0u8; length];
    reader.read_exact(&mut data).await.ok()?;
    match kind {
        FRAME_JSON => serde_json::from_slice(&data).ok().map(Frame::Json),
        FRAME_DATA => Some(Frame::Data(data)),
        _ => None,
    }
}

async fn read_json(reader: &mut (impl AsyncRead + Unpin)) -> Result<Json, String> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header).await.map_err(|e| e.to_string())?;
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if length > MAX_FRAME {
        return Err("数据帧过大".into());
    }
    let mut data = vec![0u8; length];
    reader.read_exact(&mut data).await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&data).map_err(|e| e.to_string())
}

fn hostname() -> String {
    std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Finch".into())
}
