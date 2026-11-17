use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use mysql_async::prelude::*;
use mysql_async::{Conn, Value};

use crate::db::{
    first_keyword, is_cancelled, is_connection_error, quote_id, reconnect_state,
    serialize_columns, serialize_row, split_statements, AppState, QueryControl,
};
use crate::models::*;
use crate::store;

/// Hard ceiling on how many bytes of cell data one statement may return to the
/// webview. Large TEXT/BLOB results were the main reason a "fast" query could
/// still freeze Finch for minutes while the payload was serialized and shipped
/// over IPC.
const MAX_RESULT_BYTES: usize = 6 * 1024 * 1024;

fn apply_result_limit(sql: &str, max_rows: usize) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let first = first_keyword(trimmed);
    if first != "SELECT" && first != "WITH" {
        return trimmed.to_string();
    }
    let lower = trimmed.to_lowercase();
    if lower.contains("for update")
        || lower.contains("lock in share mode")
        || lower.contains("into outfile")
        || lower.contains("into dumpfile")
    {
        return trimmed.to_string();
    }
    // Only a LIMIT at the very end of the statement bounds the whole result.
    // A LIMIT inside a subquery (`FROM (SELECT ... LIMIT 10) x JOIN big`) does
    // not, so it must not disable the outer guard.
    static TRAILING_LIMIT: OnceLock<regex::Regex> = OnceLock::new();
    let trailing_limit = TRAILING_LIMIT.get_or_init(|| {
        regex::Regex::new(r"(?i)\blimit\s+(\d+|\?)(\s*,\s*(\d+|\?)|\s+offset\s+(\d+|\?))?\s*$").unwrap()
    });
    if trailing_limit.is_match(trimmed) {
        return trimmed.to_string();
    }
    format!("{trimmed}\nLIMIT {}", max_rows + 1)
}

fn is_read_only(sql: &str) -> bool {
    crate::sql::validate_read_only(sql).is_ok()
}

fn sql_error(err: &mysql_async::Error, sql: &str) -> QueryError {
    match err {
        mysql_async::Error::Server(server) => QueryError {
            message: if server.code == 3024 {
                format!(
                    "查询超过时间上限（{}），已被 MySQL 中止。可在设置里调整或关闭该限制。",
                    server.message
                )
            } else {
                server.message.clone()
            },
            code: format!("ER_{}", server.code),
            errno: server.code as u32,
            sql_state: server.state.clone(),
            sql: sql.to_string(),
        },
        _ => QueryError {
            message: err.to_string(),
            code: "CLIENT_ERROR".into(),
            errno: 0,
            sql_state: String::new(),
            sql: sql.to_string(),
        },
    }
}

fn raw_value_bytes(value: Option<&Value>) -> usize {
    match value {
        None | Some(Value::NULL) => 1,
        Some(Value::Bytes(bytes)) => bytes.len(),
        Some(Value::Int(_)) | Some(Value::UInt(_)) | Some(Value::Float(_)) | Some(Value::Double(_)) => 9,
        Some(Value::Date(..)) | Some(Value::Time(..)) => 20,
    }
}

struct RunOutcome {
    result: StatementResult,
    /// The connection still has unread rows and must be thrown away.
    stop: bool,
    cancelled: bool,
}

async fn run_statement(
    conn: &mut Conn,
    sql: &str,
    max_rows: usize,
    auto_limit: bool,
    cancel: &AtomicBool,
) -> Result<RunOutcome, mysql_async::Error> {
    let started = Instant::now();
    let executable = if auto_limit {
        apply_result_limit(sql, max_rows)
    } else {
        sql.trim().trim_end_matches(';').to_string()
    };
    let mut query_result = conn.query_iter(&executable).await?;
    let columns_vec = query_result.columns_ref().to_vec();
    let columns = serialize_columns(&columns_vec);
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    let mut truncated_reason: Option<String> = None;
    let mut stop = false;
    let mut cancelled = false;
    if columns.is_empty() {
        let affected_rows = query_result.affected_rows();
        let insert_id = query_result.last_insert_id().map(|v| v.to_string());
        let info = query_result.info().to_string();
        let warnings = query_result.warnings();
        let duration_ms = started.elapsed().as_millis() as u64;
        query_result.drop_result().await?;
        return Ok(RunOutcome {
            result: StatementResult {
                kind: "command".into(),
                sql: sql.to_string(),
                columns,
                rows,
                row_count: 0,
                truncated: false,
                truncated_reason: None,
                duration_ms,
                affected_rows,
                insert_id,
                changed_rows: affected_rows,
                info,
                warnings,
                error: None,
            },
            stop: false,
            cancelled: false,
        });
    }

    let mut bytes = 0usize;
    while let Some(row) = query_result.next().await? {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            stop = true;
            break;
        }
        if rows.len() >= max_rows {
            truncated = true;
            truncated_reason = Some("rows".into());
            stop = true;
            break;
        }
        let row_bytes: usize = (0..row.len()).map(|index| raw_value_bytes(row.as_ref(index))).sum();
        if bytes + row_bytes > MAX_RESULT_BYTES && !rows.is_empty() {
            truncated = true;
            truncated_reason = Some("bytes".into());
            stop = true;
            break;
        }
        bytes += row_bytes;
        rows.push(serialize_row(&row));
        // Checking the flag on every row keeps Cancel responsive even when the
        // server already streamed a large result set into the socket buffer.
        if rows.len() % 128 == 0 && cancel.load(Ordering::Relaxed) {
            cancelled = true;
            stop = true;
            break;
        }
    }
    let affected_rows = query_result.affected_rows();
    let insert_id = query_result.last_insert_id().map(|v| v.to_string());
    let changed_rows = affected_rows;
    let info = query_result.info().to_string();
    let warnings = query_result.warnings();
    let duration_ms = started.elapsed().as_millis() as u64;
    drop(query_result);
    Ok(RunOutcome {
        result: StatementResult {
            kind: "rows".into(),
            sql: sql.to_string(),
            columns,
            row_count: rows.len(),
            rows,
            truncated,
            truncated_reason,
            duration_ms,
            affected_rows,
            insert_id,
            changed_rows,
            info,
            warnings,
            error: None,
        },
        stop,
        cancelled,
    })
}

struct ExecutionRegistration<'a> {
    state: &'a AppState,
    id: &'a str,
}

impl Drop for ExecutionRegistration<'_> {
    fn drop(&mut self) {
        self.state.cancels.lock().unwrap().remove(self.id);
    }
}

async fn wait_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

async fn kill_thread(opts: mysql_async::Opts, thread_id: u32) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(3), async move {
        let mut conn = Conn::new(opts).await.map_err(|e| e.to_string())?;
        let result = conn.query_drop(format!("KILL QUERY {thread_id}")).await;
        drop(conn);
        match result {
            Ok(()) => Ok(()),
            Err(mysql_async::Error::Server(error)) if error.code == 1094 => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }).await.map_err(|_| "发送取消请求超时".to_string())?
}

pub async fn execute(state: &AppState, payload: QueryPayload) -> Result<QueryResult, String> {
    let started = Instant::now();
    let session = state.session(&payload.session_id)?;
    let statements = split_statements(&payload.sql);
    if statements.is_empty() {
        return Err("没有可执行的 SQL".into());
    }
    let profile = state.profile(&payload.session_id)?;
    let read_only = profile.read_only;
    if read_only {
        for sql in &statements {
            crate::sql::validate_read_only(sql)?;
        }
    }
    let execution_id = if payload.execution_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        payload.execution_id.clone()
    };
    let max_rows = payload.max_rows.unwrap_or(5000).clamp(1, 50_000);
    let auto_limit = payload.auto_limit.unwrap_or(true);
    let control = Arc::new(QueryControl::new());
    let cancel = &control.cancelled;
    state
        .cancels
        .lock()
        .unwrap()
        .insert(execution_id.clone(), control.clone());
    let _registration = ExecutionRegistration { state, id: &execution_id };
    let timeout_ms = payload.timeout_ms.unwrap_or_else(|| {
        state.settings.lock().unwrap().query_timeout_seconds as u64 * 1000
    });
    let deadline = (timeout_ms > 0).then(|| tokio::time::Instant::now() + Duration::from_millis(timeout_ms));
    let mut timings = QueryTimings::default();
    let mut actual_thread_id = 0;

    let mut results: Vec<StatementResult> = Vec::new();
    let mut attempts = 0;
    let mut retry = false;
    let mut session = session;
    let mut was_cancelled = false;
    while attempts < 2 {
        attempts += 1;
        let acquired_at = Instant::now();
        let acquisition = tokio::select! {
            biased;
            _ = control.wait_cancelled() => { was_cancelled = true; break; }
            _ = wait_deadline(deadline) => return Err("等待数据库连接超过查询时间上限".into()),
            result = tokio::time::timeout(Duration::from_millis(session.profile.connect_timeout.max(1500)), session.pool.get_conn()) => {
                result.map_err(|_| "等待数据库连接超时，连接池可能繁忙或网络不可达".to_string())?
            }
        };
        timings.connection_ms += acquired_at.elapsed().as_millis() as u64;
        let mut conn = match acquisition {
            Ok(conn) => conn,
            Err(err) => {
                if profile.auto_reconnect && is_connection_error(&err.to_string()) && attempts < 2 {
                    let reconnected = tokio::select! {
                        _ = control.wait_cancelled() => { was_cancelled = true; break; }
                        _ = wait_deadline(deadline) => return Err("重新连接超过查询时间上限".into()),
                        result = reconnect_state(state, &payload.session_id) => result,
                    };
                    if let Ok(new_session) = reconnected {
                        session = new_session;
                        continue;
                    }
                }
                return Err(err.to_string());
            }
        };
        let tid = conn.id();
        actual_thread_id = tid;
        *control.thread_id.lock().unwrap() = Some(tid);
        let mut connection_broken = false;
        let prepare_started = Instant::now();
        let setup = async {
            if !payload.database.is_empty() {
                conn.query_drop(format!("USE {}", quote_id(&payload.database))).await?;
            }
            // Reset to zero when disabled, even if this pool socket had a timeout.
            let _ = conn
                .query_drop(format!("SET SESSION max_execution_time = {timeout_ms}"))
                .await;
            if read_only {
                // Server-side protection also prevents writes hidden inside stored functions.
                conn.query_drop("START TRANSACTION READ ONLY").await?;
            }
            Ok::<(), mysql_async::Error>(())
        };
        let setup_result = tokio::select! {
            biased;
            _ = control.wait_cancelled() => { was_cancelled = true; Ok(()) }
            _ = wait_deadline(deadline) => Err("准备查询超过时间上限".to_string()),
            result = tokio::time::timeout(Duration::from_secs(10), setup) => {
                result.map_err(|_| "准备查询超时，请检查数据库连接".to_string())
                    .and_then(|r| r.map_err(|e| e.to_string()))
            }
        };
        timings.prepare_ms += prepare_started.elapsed().as_millis() as u64;
        if was_cancelled || setup_result.is_err() {
            let _ = tokio::time::timeout(Duration::from_millis(250), conn.disconnect()).await;
            setup_result?;
            break;
        }
        for sql in &statements {
            if cancel.load(Ordering::Relaxed) {
                was_cancelled = true;
                break;
            }
            let statement_started = Instant::now();
            let outcome = tokio::select! {
                biased;
                _ = control.wait_cancelled() => {
                    was_cancelled = true;
                    connection_broken = true;
                    break;
                }
                _ = wait_deadline(deadline) => {
                    connection_broken = true;
                    results.push(StatementResult {
                        kind: "error".into(), sql: sql.clone(), columns: vec![], rows: vec![],
                        row_count: 0, truncated: false, truncated_reason: None,
                        duration_ms: statement_started.elapsed().as_millis() as u64,
                        affected_rows: 0, insert_id: None, changed_rows: 0, info: String::new(), warnings: 0,
                        error: Some(QueryError {
                            message: "查询超过时间上限，已停止等待并请求 MySQL 终止执行。写入操作请核对实际执行状态后再决定是否重试。".into(),
                            code: "CLIENT_TIMEOUT".into(), errno: 0, sql_state: String::new(), sql: sql.clone(),
                        }),
                    });
                    let opts = session.opts.clone();
                    tokio::spawn(async move { let _ = kill_thread(opts, tid).await; });
                    break;
                }
                result = run_statement(&mut conn, sql, max_rows, auto_limit, cancel) => result,
            };
            timings.execution_ms += statement_started.elapsed().as_millis() as u64;
            match outcome {
                Ok(outcome) => {
                    if outcome.stop {
                        connection_broken = true;
                    }
                    if outcome.cancelled {
                        was_cancelled = true;
                    }
                    results.push(outcome.result);
                    if outcome.stop {
                        break;
                    }
                }
                Err(err) => {
                    connection_broken = true;
                    if is_cancelled(state, &execution_id) {
                        was_cancelled = true;
                        connection_broken = true;
                        break;
                    }
                    let connection_error = is_connection_error(&err.to_string());
                    let read_only_first = results.is_empty() && statements.len() == 1 && is_read_only(sql);
                    results.push(StatementResult {
                        kind: "error".into(),
                        sql: sql.clone(),
                        columns: vec![],
                        rows: vec![],
                        row_count: 0,
                        truncated: false,
                        truncated_reason: None,
                        duration_ms: 0,
                        affected_rows: 0,
                        insert_id: None,
                        changed_rows: 0,
                        info: String::new(),
                        warnings: 0,
                        error: Some(sql_error(&err, sql)),
                    });
                    if profile.auto_reconnect && connection_error && read_only_first && attempts < 2 {
                        results.clear();
                        retry = true;
                    }
                    break;
                }
            }
        }
        {
            // Coordinate with Cancel before returning the socket to the pool.
            let mut thread_id = control.thread_id.lock().unwrap();
            connection_broken |= control.cancelled.load(Ordering::Relaxed);
            *thread_id = None;
        }
        if connection_broken {
            // Drop the socket instead of recycling it: the result stream was not
            // fully consumed, and draining it would read the very rows we just
            // refused to load.
            let _ = tokio::time::timeout(Duration::from_millis(250), conn.disconnect()).await;
        } else {
            if read_only {
                let rolled_back = tokio::time::timeout(Duration::from_secs(1), conn.query_drop("ROLLBACK")).await;
                if !matches!(rolled_back, Ok(Ok(()))) {
                    let _ = tokio::time::timeout(Duration::from_millis(250), conn.disconnect()).await;
                } else {
                    drop(conn);
                }
            } else {
                drop(conn);
            }
        }
        if retry {
            retry = false;
            let reconnected = tokio::select! {
                _ = control.wait_cancelled() => { was_cancelled = true; break; }
                _ = wait_deadline(deadline) => return Err("重新连接超过查询时间上限".into()),
                result = reconnect_state(state, &payload.session_id) => result,
            };
            if let Ok(new_session) = reconnected {
                session = new_session;
                continue;
            }
        }
        break;
    }
    let cancelled = was_cancelled || cancel.load(Ordering::Relaxed);
    let duration_ms = started.elapsed().as_millis() as u64;
    let failed = results.iter().find(|s| s.kind == "error");
    let row_count: usize = results.iter().map(|s| s.row_count).sum();
    let history = HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: payload.session_id.clone(),
        connection_name: session.profile.name.clone(),
        database: payload.database.clone(),
        sql: payload.sql.chars().take(20_000).collect(),
        duration_ms,
        statement_count: statements.len(),
        row_count,
        success: failed.is_none() && !cancelled,
        error: failed
            .and_then(|s| s.error.as_ref())
            .map(|e| e.message.clone())
            .unwrap_or_default(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    {
        let mut items = state.history.lock().unwrap();
        items.insert(0, history);
        items.truncate(500);
    }
    // Disk serialization is not on the result-delivery path. Lock the current
    // history in the worker so clear/delete cannot be overwritten by an old save.
    let history = state.history.clone();
    tokio::task::spawn_blocking(move || {
        let items = history.lock().unwrap();
        let _ = store::save_history(&items);
    });
    Ok(QueryResult {
        execution_id: execution_id.clone(),
        statements: results,
        duration_ms,
        cancelled,
        server_version: session.version.clone(),
        database: payload.database.clone(),
        thread_id: actual_thread_id,
        timings,
    })
}

pub async fn cancel(state: &AppState, execution_id: &str, session_id: &str) -> Result<bool, String> {
    let control = state.cancels.lock().unwrap().get(execution_id).cloned();
    let Some(control) = control else { return Ok(false) };
    let thread_id = {
        let thread_id = control.thread_id.lock().unwrap();
        control.cancel();
        *thread_id
    };
    if let Some(thread_id) = thread_id {
        let session = state.session(session_id)?;
        kill_thread(session.opts.clone(), thread_id).await?;
    }
    Ok(true)
}


#[cfg(test)]
mod tests {
    use super::apply_result_limit;

    #[test]
    fn only_trailing_limit_disables_the_guard() {
        assert_eq!(
            apply_result_limit("SELECT * FROM t LIMIT 10", 5000),
            "SELECT * FROM t LIMIT 10"
        );
        assert_eq!(
            apply_result_limit("SELECT * FROM t LIMIT 10, 20;", 5000),
            "SELECT * FROM t LIMIT 10, 20"
        );
        assert_eq!(apply_result_limit("SELECT * FROM t LIMIT 20 OFFSET 10", 5000), "SELECT * FROM t LIMIT 20 OFFSET 10");
        let subquery = apply_result_limit("SELECT * FROM (SELECT * FROM t LIMIT 10) x JOIN big b", 5000);
        assert!(subquery.ends_with("LIMIT 5001"), "{subquery}");
        let plain = apply_result_limit("SELECT * FROM t WHERE a = 1", 100);
        assert!(plain.ends_with("LIMIT 101"), "{plain}");
        let locked = apply_result_limit("SELECT * FROM t FOR UPDATE", 100);
        assert!(!locked.contains("LIMIT"), "{locked}");
        assert!(!apply_result_limit("UPDATE t SET a = 1", 100).contains("LIMIT"));
    }
}
