use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::stream::{self, StreamExt};
use mysql_async::prelude::*;
use mysql_async::{Params, Row, Value};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::db::{mysql_to_text, qualify, quote_id, AppState, Session};
use crate::models::*;
use crate::schema;

const SHARD_ROW_THRESHOLD: u64 = 5_000;
const MAX_BATCH: usize = 20_000;
const MAX_CONCURRENCY: usize = 8;

fn target_allowed(profile: &ConnectionProfile) -> bool {
    matches!(profile.category.as_str(), "local" | "dev")
}

pub async fn preview(
    state: &AppState,
    source_id: &str,
    target_id: &str,
    source_database: &str,
    target_database: &str,
) -> Result<serde_json::Value, String> {
    let target = state.profile(target_id)?;
    if !target_allowed(&target) {
        return Err("同步目标只能是「本地」或「开发」环境的连接".into());
    }
    if source_id == target_id && source_database == target_database {
        return Err("源和目标不能是同一个数据库".into());
    }
    let source_tables = schema::list_tables(state, source_id, source_database, "table").await?;
    let target_tables = schema::list_tables(state, target_id, target_database, "table").await?;
    let target_names: HashSet<String> = target_tables.iter().map(|t| t.name.clone()).collect();
    let tables: Vec<serde_json::Value> = source_tables
        .iter()
        .map(|table| {
            json!({
                "name": table.name,
                "rows": table.row_estimate,
                "bytes": table.data_length + table.index_length,
                "exists": target_names.contains(&table.name),
            })
        })
        .collect();
    Ok(json!({
        "tables": tables,
        "targetCategory": target.category,
        "targetName": target.name,
    }))
}

async fn create_table(
    source: &AppState,
    target_conn: &mut mysql_async::Conn,
    source_id: &str,
    source_database: &str,
    table: &str,
) -> Result<(), String> {
    let details = schema::get_table_details(source, source_id, source_database, table).await?;
    if details.ddl.trim().is_empty() {
        return Err(format!("无法读取 {table} 的建表语句"));
    }
    let ddl = if details.ddl.trim_start().to_uppercase().starts_with("CREATE TABLE") {
        details.ddl.replacen("CREATE TABLE", "CREATE TABLE IF NOT EXISTS", 1)
    } else {
        details.ddl.clone()
    };
    // Execute the source DDL as-is (only when the target table is absent). Existing
    // target DDL is never altered by sync.
    target_conn
        .query_drop(ddl)
        .await
        .map_err(|e| format!("建表失败 {table}: {e}"))
}

fn build_insert(
    database: &str,
    table: &str,
    columns: &[String],
    pk: &[String],
    mode: &str,
    row_count: usize,
) -> String {
    let col_list = columns.iter().map(|c| quote_id(c)).collect::<Vec<_>>().join(", ");
    let row_placeholder = format!("({})", vec!["?"; columns.len()].join(", "));
    let placeholders = vec![row_placeholder; row_count].join(", ");
    let update_cols: Vec<&String> = columns
        .iter()
        .filter(|c| !pk.iter().any(|k| k == *c))
        .collect();
    let (verb, suffix) = if mode == "upsert" && !pk.is_empty() && update_cols.is_empty() {
        ("INSERT IGNORE", String::new())
    } else if mode == "upsert" && !pk.is_empty() {
        (
            "INSERT",
            format!(
                " ON DUPLICATE KEY UPDATE {}",
                update_cols
                    .iter()
                    .map(|c| format!("{} = VALUES({})", quote_id(c), quote_id(c)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
    } else {
        ("INSERT", String::new())
    };
    format!(
        "{verb} INTO {} ({}) VALUES {}{}",
        qualify(database, table),
        col_list,
        placeholders,
        suffix
    )
}

fn numeric_pk(column: &ColumnInfo) -> bool {
    matches!(
        column.data_type.to_uppercase().as_str(),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT"
    )
}

#[derive(Clone, Copy)]
struct Shard {
    start: Option<i128>,
    end: Option<i128>,
}

struct TablePlan {
    index: usize,
    name: String,
    mode: String,
    common: Vec<String>,
    source_pk: Option<String>,
    source_pk_pos: Option<usize>,
    target_pk: Vec<String>,
    shards: Vec<Shard>,
    created: bool,
    skipped: Vec<String>,
    read: Arc<AtomicU64>,
    written: Arc<AtomicU64>,
    error: Option<String>,
}

#[derive(Clone)]
struct ShardJob {
    source: Arc<Session>,
    target: Arc<Session>,
    source_db: String,
    target_db: String,
    batch_size: usize,
    plan: Arc<TablePlan>,
    shard: Shard,
    app: Option<AppHandle>,
}

fn shard_ranges(min: i128, max: i128, count: usize) -> Vec<Shard> {
    if max < min || count <= 1 {
        return vec![Shard { start: Some(min), end: Some(max) }];
    }
    let span = (max - min + count as i128) / count as i128;
    if span <= 0 {
        return vec![Shard { start: Some(min), end: Some(max) }];
    }
    let mut shards = Vec::new();
    let mut start = min;
    for _ in 0..count {
        if start > max {
            break;
        }
        let end = (start + span - 1).min(max);
        shards.push(Shard { start: Some(start), end: Some(end) });
        start = end + 1;
    }
    if shards.is_empty() {
        shards.push(Shard { start: Some(min), end: Some(max) });
    }
    shards
}

async fn write_batch(
    target: &mut mysql_async::Conn,
    database: &str,
    table: &str,
    columns: &[String],
    pk: &[String],
    mode: &str,
    batch: &[Vec<Value>],
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let sql = build_insert(database, table, columns, pk, mode, batch.len());
    let params: Vec<Value> = batch.iter().flatten().cloned().collect();
    target
        .exec_drop(sql, Params::Positional(params))
        .await
        .map_err(|e| e.to_string())
}

fn emit_progress(app: &Option<AppHandle>, job: &ShardJob) {
    if let Some(app) = app {
        let _ = app.emit(
            "finch://event",
            json!({
                "type": "sync:progress",
                "table": job.plan.name,
                "index": job.plan.index,
                "total": 0,
                "read": job.plan.read.load(Ordering::Relaxed),
                "written": job.plan.written.load(Ordering::Relaxed)
            }),
        );
    }
}

async fn run_shard(job: ShardJob) -> Result<(), String> {
    let mut source = job
        .source
        .pool
        .get_conn()
        .await
        .map_err(|e| format!("读取源表连接失败: {e}"))?;
    let mut target = job
        .target
        .pool
        .get_conn()
        .await
        .map_err(|e| format!("写入目标连接失败: {e}"))?;
    let _ = target.query_drop("SET SESSION foreign_key_checks=0").await;
    let _ = target.query_drop("SET SESSION unique_checks=0").await;

    let result = sync_shard_rows(&mut source, &mut target, &job).await;

    let _ = target.query_drop("SET SESSION foreign_key_checks=1").await;
    let _ = target.query_drop("SET SESSION unique_checks=1").await;
    result
}

async fn sync_shard_rows(
    source: &mut mysql_async::Conn,
    target: &mut mysql_async::Conn,
    job: &ShardJob,
) -> Result<(), String> {
    let plan = &job.plan;
    let cols_sql = plan.common.iter().map(|c| quote_id(c)).collect::<Vec<_>>().join(", ");
    let table = qualify(&job.source_db, &plan.name);
    let effective_batch = job
        .batch_size
        .min((60_000 / plan.common.len().max(1)).max(50))
        .max(1);
    let page_size = (effective_batch * 4).clamp(500, MAX_BATCH);

    if let (Some(pk), Some(pk_pos)) = (plan.source_pk.as_ref(), plan.source_pk_pos) {
        // Keyset cursor per shard: never OFFSET, so a large table stays fast
        // even when the source is being written while the sync runs.
        let mut last: Option<i128> = None;
        loop {
            let mut clauses: Vec<String> = Vec::new();
            let mut params: Vec<Value> = Vec::new();
            if let Some(start) = job.shard.start {
                clauses.push(format!("{} >= ?", quote_id(pk)));
                params.push(Value::Bytes(start.to_string().into_bytes()));
            }
            if let Some(end) = job.shard.end {
                clauses.push(format!("{} <= ?", quote_id(pk)));
                params.push(Value::Bytes(end.to_string().into_bytes()));
            }
            if let Some(last) = last {
                clauses.push(format!("{} > ?", quote_id(pk)));
                params.push(Value::Bytes(last.to_string().into_bytes()));
            }
            let mut sql = format!("SELECT {cols_sql} FROM {table}");
            if !clauses.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&clauses.join(" AND "));
            }
            sql.push_str(&format!(" ORDER BY {} ASC LIMIT ?", quote_id(pk)));
            params.push(Value::UInt(page_size as u64));

            let mut query = source
                .exec_iter(sql, Params::Positional(params))
                .await
                .map_err(|e| e.to_string())?;
            let mut batch: Vec<Vec<Value>> = Vec::new();
            let mut page_last: Option<i128> = None;
            let mut page_rows = 0usize;
            while let Some(row) = query.next().await.map_err(|e| e.to_string())? {
                let values: Vec<Value> = (0..plan.common.len())
                    .map(|i| row.as_ref(i).cloned().unwrap_or(Value::NULL))
                    .collect();
                if let Some(value) = row.as_ref(pk_pos) {
                    page_last = mysql_to_text(Some(value)).parse::<i128>().ok();
                }
                batch.push(values);
                page_rows += 1;
                plan.read.fetch_add(1, Ordering::Relaxed);
                if batch.len() >= effective_batch {
                    write_batch(target, &job.target_db, &plan.name, &plan.common, &plan.target_pk, &plan.mode, &batch).await?;
                    plan.written.fetch_add(batch.len() as u64, Ordering::Relaxed);
                    batch.clear();
                    emit_progress(&job.app, job);
                }
            }
            drop(query);
            if !batch.is_empty() {
                write_batch(target, &job.target_db, &plan.name, &plan.common, &plan.target_pk, &plan.mode, &batch).await?;
                plan.written.fetch_add(batch.len() as u64, Ordering::Relaxed);
                emit_progress(&job.app, job);
            }
            if page_rows == 0 {
                break;
            }
            last = page_last;
            if page_rows < page_size || last.is_none() {
                break;
            }
        }
        return Ok(());
    }

    let sql = format!("SELECT {cols_sql} FROM {table}");
    let mut query = source.exec_iter(sql, Params::Positional(vec![])).await.map_err(|e| e.to_string())?;
    let mut batch: Vec<Vec<Value>> = Vec::new();
    while let Some(row) = query.next().await.map_err(|e| e.to_string())? {
        let values: Vec<Value> = (0..plan.common.len())
            .map(|i| row.as_ref(i).cloned().unwrap_or(Value::NULL))
            .collect();
        batch.push(values);
        plan.read.fetch_add(1, Ordering::Relaxed);
        if batch.len() >= effective_batch {
            write_batch(target, &job.target_db, &plan.name, &plan.common, &plan.target_pk, &plan.mode, &batch).await?;
            plan.written.fetch_add(batch.len() as u64, Ordering::Relaxed);
            batch.clear();
            emit_progress(&job.app, job);
        }
    }
    drop(query);
    if !batch.is_empty() {
        write_batch(target, &job.target_db, &plan.name, &plan.common, &plan.target_pk, &plan.mode, &batch).await?;
        plan.written.fetch_add(batch.len() as u64, Ordering::Relaxed);
        emit_progress(&job.app, job);
    }
    Ok(())
}

pub async fn run(
    app: Option<&AppHandle>,
    state: &AppState,
    request: SyncRequest,
) -> Result<SyncResult, String> {
    let target = state.profile(&request.target_id)?;
    if !target_allowed(&target) {
        return Err("同步目标只能是「本地」或「开发」环境的连接".into());
    }
    state.ensure_writable(&request.target_id)?;
    if request.source_id == request.target_id && request.source_database == request.target_database {
        return Err("源和目标不能是同一个数据库".into());
    }
    if request.tables.is_empty() {
        return Err("请至少选择一张表".into());
    }

    let started = Instant::now();
    let source_session = state.session(&request.source_id)?;
    let target_session = state.session(&request.target_id)?;
    // Same pool: each job holds one source + one target connection. Keeping the
    // worker count at 4 prevents a 16-connection wait against an 8-connection pool.
    let max_concurrency = if request.source_id == request.target_id { 4 } else { MAX_CONCURRENCY };
    let concurrency = request.concurrency.unwrap_or(4).clamp(1, max_concurrency);
    let batch_size = request.batch_size.unwrap_or(2_000).clamp(50, MAX_BATCH);
    let source_tables = schema::list_tables(state, &request.source_id, &request.source_database, "table").await?;
    let target_tables = schema::list_tables(state, &request.target_id, &request.target_database, "table").await?;
    let source_names: HashSet<String> = source_tables.iter().map(|t| t.name.clone()).collect();
    let mut target_names: HashSet<String> = target_tables.iter().map(|t| t.name.clone()).collect();

    let mut bootstrap = target_session.pool.get_conn().await.map_err(|e| e.to_string())?;
    bootstrap
        .query_drop(format!("USE {}", quote_id(&request.target_database)))
        .await
        .map_err(|e| e.to_string())?;
    bootstrap.query_drop("SET SESSION foreign_key_checks=0").await.map_err(|e| e.to_string())?;
    bootstrap.query_drop("SET SESSION unique_checks=0").await.map_err(|e| e.to_string())?;

    let mut plans: Vec<Arc<TablePlan>> = Vec::new();
    let mut created_tables: Vec<String> = Vec::new();
    for (index, item) in request.tables.iter().enumerate() {
        let mut plan = TablePlan {
            index,
            name: item.name.clone(),
            mode: item.mode.clone(),
            common: Vec::new(),
            source_pk: None,
            source_pk_pos: None,
            target_pk: Vec::new(),
            shards: vec![Shard { start: None, end: None }],
            created: false,
            skipped: Vec::new(),
            read: Arc::new(AtomicU64::new(0)),
            written: Arc::new(AtomicU64::new(0)),
            error: None,
        };
        if !source_names.contains(&item.name) {
            plan.error = Some("源数据库中不存在这张表".into());
            plans.push(Arc::new(plan));
            continue;
        }
        let existed = target_names.contains(&item.name);
        if !existed {
            if !request.create_missing {
                plan.error = Some("目标表不存在，且未开启自动建表".into());
                plans.push(Arc::new(plan));
                continue;
            }
            if let Err(err) = create_table(
                state,
                &mut bootstrap,
                &request.source_id,
                &request.source_database,
                &item.name,
            )
            .await
            {
                plan.error = Some(err);
                plans.push(Arc::new(plan));
                continue;
            }
            plan.created = true;
            created_tables.push(item.name.clone());
            target_names.insert(item.name.clone());
        }

        let source_columns = match schema::list_columns(state, &request.source_id, &request.source_database, &item.name).await {
            Ok(columns) => columns,
            Err(err) => {
                plan.error = Some(err);
                plans.push(Arc::new(plan));
                continue;
            }
        };
        let target_columns = if plan.created {
            source_columns.clone()
        } else {
            match schema::list_columns(state, &request.target_id, &request.target_database, &item.name).await {
                Ok(columns) => columns,
                Err(err) => {
                    plan.error = Some(err);
                    plans.push(Arc::new(plan));
                    continue;
                }
            }
        };
        let target_names_set: HashSet<&str> = target_columns.iter().map(|c| c.name.as_str()).collect();
        plan.common = source_columns
            .iter()
            .filter(|c| target_names_set.contains(c.name.as_str()))
            .map(|c| c.name.clone())
            .collect();
        plan.skipped = source_columns
            .iter()
            .filter(|c| !target_names_set.contains(c.name.as_str()))
            .map(|c| c.name.clone())
            .collect();
        if plan.common.is_empty() {
            plan.error = Some("源表和目标表没有同名字段".into());
            plans.push(Arc::new(plan));
            continue;
        }
        plan.target_pk = target_columns
            .iter()
            .filter(|c| c.column_key == "PRI")
            .map(|c| c.name.clone())
            .collect();
        plan.mode = if item.mode == "upsert" && plan.target_pk.is_empty() {
            "append".into()
        } else {
            item.mode.clone()
        };
        if plan.mode == "replace" {
            if let Err(err) = bootstrap
                .query_drop(format!("TRUNCATE TABLE {}", qualify(&request.target_database, &item.name)))
                .await
            {
                plan.error = Some(format!("清空目标表失败: {err}"));
                plans.push(Arc::new(plan));
                continue;
            }
        }
        // A component of a composite PK is not unique. Such tables use the
        // bounded streaming path below, which reads every row without a cursor.
        let source_keys: Vec<_> = source_columns.iter().filter(|c| c.column_key == "PRI").collect();
        if let Some(column) = source_keys.first().filter(|column| source_keys.len() == 1 && numeric_pk(column)) {
            if let Some(pos) = plan.common.iter().position(|name| name == &column.name) {
                plan.source_pk = Some(column.name.clone());
                plan.source_pk_pos = Some(pos);
            }
        }

        if concurrency > 1 {
            if let Some(pk) = plan.source_pk.as_ref() {
                if let Ok(mut conn) = source_session.pool.get_conn().await {
                    let sql = format!(
                        "SELECT MIN({}), MAX({}) FROM {}",
                        quote_id(pk),
                        quote_id(pk),
                        qualify(&request.source_database, &item.name)
                    );
                    if let Ok(Some(row)) = conn.query_first::<Row, _>(sql).await {
                        let min = mysql_to_text(row.as_ref(0)).parse::<i128>().ok();
                        let max = mysql_to_text(row.as_ref(1)).parse::<i128>().ok();
                        if let (Some(min), Some(max)) = (min, max) {
                            if max > min && max - min + 1 >= SHARD_ROW_THRESHOLD as i128 {
                                plan.shards = shard_ranges(min, max, concurrency);
                            }
                        }
                    }
                }
            }
        }
        plans.push(Arc::new(plan));
    }

    let _ = bootstrap.query_drop("SET SESSION foreign_key_checks=1").await;
    let _ = bootstrap.query_drop("SET SESSION unique_checks=1").await;
    drop(bootstrap);

    let mut jobs: Vec<ShardJob> = Vec::new();
    for plan in &plans {
        if plan.error.is_some() {
            continue;
        }
        for shard in &plan.shards {
            jobs.push(ShardJob {
                source: source_session.clone(),
                target: target_session.clone(),
                source_db: request.source_database.clone(),
                target_db: request.target_database.clone(),
                batch_size,
                plan: plan.clone(),
                shard: *shard,
                app: app.cloned(),
            });
        }
    }

    let outcomes: Vec<(usize, Result<(), String>)> = stream::iter(jobs)
        .map(|job| async move {
            let index = job.plan.index;
            (index, run_shard(job).await)
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    let mut errors: Vec<Option<String>> = vec![None; plans.len()];
    for (index, outcome) in outcomes {
        if let Err(err) = outcome {
            if errors[index].is_none() {
                errors[index] = Some(err);
            }
        }
    }

    let mut result = SyncResult { created_tables, ..Default::default() };
    for plan in &plans {
        let error = plan.error.clone().or_else(|| errors[plan.index].clone());
        let table_result = SyncTableResult {
            table: plan.name.clone(),
            created: plan.created,
            read: plan.read.load(Ordering::Relaxed),
            written: plan.written.load(Ordering::Relaxed),
            skipped_columns: plan.skipped.clone(),
            error: error.clone(),
            shards: plan.shards.len(),
        };
        if let Some(app) = app {
            let _ = app.emit(
                "finch://event",
                json!({
                    "type": "sync:table",
                    "table": table_result.table,
                    "index": plan.index,
                    "total": plans.len(),
                    "read": table_result.read,
                    "written": table_result.written,
                    "created": table_result.created,
                    "error": table_result.error,
                    "shards": table_result.shards
                }),
            );
        }
        result.tables.push(table_result);
    }
    result.duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::shard_ranges;

    #[test]
    fn shards_cover_the_whole_range() {
        let shards = shard_ranges(1, 100, 4);
        assert_eq!(shards.len(), 4);
        assert_eq!(shards[0].start, Some(1));
        assert_eq!(shards[3].end, Some(100));
        for pair in shards.windows(2) {
            assert_eq!(pair[0].end.unwrap() + 1, pair[1].start.unwrap());
        }
        let all = shard_ranges(42, 42, 8);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].start, Some(42));
    }
}
