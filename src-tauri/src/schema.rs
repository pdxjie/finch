use std::time::Duration;

use mysql_async::prelude::*;
use mysql_async::{Params, Row, TxOpts, Value};
use serde_json::{json, Value as Json};

use crate::db::{
    mysql_to_text, qualify, quote_id, serialize_columns, serialize_row, AppState,
};
use crate::models::*;

fn value_string(row: &Row, index: usize) -> String {
    row.as_ref(index)
        .map(|value| crate::db::mysql_to_text(Some(value)))
        .unwrap_or_default()
}
fn value_opt(row: &Row, index: usize) -> Option<String> {
    row.as_ref(index)
        .map(|value| crate::db::mysql_to_text(Some(value)))
        .filter(|value| !value.is_empty())
}
fn value_i64(row: &Row, index: usize) -> i64 {
    value_string(row, index).parse().unwrap_or(0)
}
fn value_u64(row: &Row, index: usize) -> u64 {
    value_string(row, index).parse().unwrap_or(0)
}
fn value_opt_i64(row: &Row, index: usize) -> Option<i64> {
    value_opt(row, index).and_then(|value| value.parse().ok())
}

pub async fn list_databases(state: &AppState, session_id: &str) -> Result<Vec<DatabaseInfo>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .query::<Row, _>(
            "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME \
             FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
        )
        .await
        .map_err(|e| e.to_string())?;
    let system = ["information_schema", "performance_schema", "mysql", "sys"];
    Ok(rows
        .iter()
        .map(|row| {
            let name = value_string(row, 0);
            DatabaseInfo {
                is_system: system.contains(&name.as_str()),
                charset: value_string(row, 1),
                collation: value_string(row, 2),
                name,
            }
        })
        .collect())
}

pub async fn list_tables(
    state: &AppState,
    session_id: &str,
    database: &str,
    kind: &str,
) -> Result<Vec<TableInfo>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let filter = if kind == "view" { "VIEW" } else { "BASE TABLE" };
    let rows = conn
        .exec::<Row, _, _>(
            "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT, \
             COALESCE(DATA_LENGTH,0), COALESCE(INDEX_LENGTH,0), TABLE_COLLATION, CREATE_TIME \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? \
             ORDER BY TABLE_NAME",
            Params::Positional(vec![
                Value::Bytes(database.as_bytes().to_vec()),
                Value::Bytes(filter.as_bytes().to_vec()),
            ]),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: value_string(row, 0),
            table_type: value_string(row, 1),
            engine: value_opt(row, 2),
            row_estimate: value_opt_i64(row, 3),
            comment: value_string(row, 4),
            data_length: value_u64(row, 5),
            index_length: value_u64(row, 6),
            collation: value_opt(row, 7),
            create_time: value_opt(row, 8),
        })
        .collect())
}

pub async fn list_columns(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .exec::<Row, _, _>(
            "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, \
             COLUMN_KEY, COLUMN_COMMENT, ORDINAL_POSITION, CHARACTER_SET_NAME, COLLATION_NAME, \
             COALESCE(GENERATION_EXPRESSION,'') \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION",
            Params::Positional(vec![
                Value::Bytes(database.as_bytes().to_vec()),
                Value::Bytes(table.as_bytes().to_vec()),
            ]),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            name: value_string(row, 0),
            column_type: value_string(row, 1),
            data_type: value_string(row, 2),
            nullable: value_string(row, 3),
            default_value: value_opt(row, 4),
            extra: value_string(row, 5),
            column_key: value_string(row, 6),
            comment: value_string(row, 7),
            position: value_i64(row, 8),
            charset: value_opt(row, 9),
            collation: value_opt(row, 10),
            generation_expression: value_string(row, 11),
        })
        .collect())
}

pub async fn list_indexes(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .query::<Row, _>(format!("SHOW INDEX FROM {}", qualify(database, table)))
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| IndexInfo {
            name: value_string(row, 2),
            column: value_string(row, 4),
            unique: value_i64(row, 1) == 0,
            sequence: value_i64(row, 3),
            cardinality: value_opt_i64(row, 6),
            index_type: value_string(row, 10),
            nullable: value_string(row, 9) == "YES",
            comment: value_string(row, 11),
        })
        .collect())
}

pub async fn list_foreign_keys(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .exec::<Row, _, _>(
            "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, \
             k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
             ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME \
             WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            Params::Positional(vec![
                Value::Bytes(database.as_bytes().to_vec()),
                Value::Bytes(table.as_bytes().to_vec()),
            ]),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: value_string(row, 0),
            column_name: value_string(row, 1),
            ref_database: value_string(row, 2),
            ref_table: value_string(row, 3),
            ref_column: value_string(row, 4),
            on_update: value_string(row, 5),
            on_delete: value_string(row, 6),
        })
        .collect())
}

pub async fn get_table_details(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
) -> Result<TableDetails, String> {
    let session = state.session(session_id)?;
    let columns = list_columns(state, session_id, database, table).await?;
    let indexes = list_indexes(state, session_id, database, table).await?;
    let foreign_keys = list_foreign_keys(state, session_id, database, table).await?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let ddl = conn
        .query::<Row, _>(format!("SHOW CREATE TABLE {}", qualify(database, table)))
        .await
        .ok()
        .and_then(|rows| rows.first().map(|row| value_string(row, 1)))
        .unwrap_or_default();
    let triggers = conn
        .exec::<Row, _, _>(
            "SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT \
             FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?",
            Params::Positional(vec![
                Value::Bytes(database.as_bytes().to_vec()),
                Value::Bytes(table.as_bytes().to_vec()),
            ]),
        )
        .await
        .ok()
        .unwrap_or_default()
        .iter()
        .map(|row| TriggerInfo {
            name: value_string(row, 0),
            event: value_string(row, 1),
            timing: value_string(row, 2),
            statement: value_string(row, 3),
        })
        .collect();
    let primary_keys = columns
        .iter()
        .filter(|c| c.column_key == "PRI")
        .map(|c| c.name.clone())
        .collect();
    Ok(TableDetails {
        columns,
        indexes,
        foreign_keys,
        triggers,
        ddl,
        primary_keys,
    })
}

pub async fn list_routines(
    state: &AppState,
    session_id: &str,
    database: &str,
) -> Result<Vec<Json>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .exec::<Row, _, _>(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE, COALESCE(DTD_IDENTIFIER,''), COALESCE(ROUTINE_COMMENT,'') \
             FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
            Params::Positional(vec![Value::Bytes(database.as_bytes().to_vec())]),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| json!({
            "name": value_string(row, 0),
            "type": value_string(row, 1),
            "returnType": value_string(row, 2),
            "comment": value_string(row, 3),
        }))
        .collect())
}

fn build_where(
    filters: &[TableFilter],
    search: &str,
    columns: &[ColumnInfo],
    values: &mut Vec<Value>,
) -> String {
    let valid: std::collections::HashSet<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    let mut clauses: Vec<String> = Vec::new();
    for filter in filters {
        if !valid.contains(filter.column.as_str()) {
            continue;
        }
        let op = filter.op.to_uppercase();
        let column = quote_id(&filter.column);
        if op == "IS NULL" || op == "IS NOT NULL" {
            clauses.push(format!("{column} {op}"));
            continue;
        }
        if op == "IS EMPTY" || op == "IS NOT EMPTY" {
            clauses.push(format!("{column} {} ''", if op == "IS EMPTY" { "=" } else { "!=" }));
            continue;
        }
        if op == "BETWEEN" || op == "NOT BETWEEN" {
            let Some(upper) = filter.value2.as_deref().filter(|value| !value.is_empty()) else {
                continue;
            };
            clauses.push(format!("{column} {op} ? AND ?"));
            values.push(Value::Bytes(filter.value.as_bytes().to_vec()));
            values.push(Value::Bytes(upper.as_bytes().to_vec()));
            continue;
        }
        if op == "IN" || op == "NOT IN" {
            let items: Vec<&str> = filter.value.split(',').map(str::trim).filter(|v| !v.is_empty()).collect();
            if items.is_empty() {
                continue;
            }
            let placeholders = vec!["?"; items.len()].join(", ");
            clauses.push(format!("{column} {op} ({placeholders})"));
            for item in items {
                values.push(Value::Bytes(item.as_bytes().to_vec()));
            }
            continue;
        }
        let like_op = match op.as_str() {
            "CONTAINS" | "NOT CONTAINS" => Some(if op == "CONTAINS" { "LIKE" } else { "NOT LIKE" }),
            "STARTS WITH" => Some("LIKE"),
            "ENDS WITH" => Some("LIKE"),
            _ => None,
        };
        if let Some(like_op) = like_op {
            let pattern = match op.as_str() {
                "CONTAINS" | "NOT CONTAINS" => format!("%{}%", filter.value),
                "STARTS WITH" => format!("{}%", filter.value),
                _ => format!("%{}", filter.value),
            };
            clauses.push(format!("{column} {like_op} ?"));
            values.push(Value::Bytes(pattern.into_bytes()));
            continue;
        }
        if !["=", "!=", ">", ">=", "<", "<=", "LIKE", "NOT LIKE"].contains(&op.as_str()) {
            continue;
        }
        clauses.push(format!("{column} {op} ?"));
        values.push(Value::Bytes(filter.value.as_bytes().to_vec()));
    }
    if !search.is_empty() {
        let text_columns: Vec<&ColumnInfo> = columns
            .iter()
            .filter(|c| {
                !c.data_type.to_uppercase().contains("BLOB")
                    && !c.data_type.to_uppercase().contains("BINARY")
                    && c.data_type.to_uppercase() != "BIT"
                    && c.data_type.to_uppercase() != "GEOMETRY"
            })
            .take(12)
            .collect();
        if !text_columns.is_empty() {
            let parts: Vec<String> = text_columns
                .iter()
                .map(|c| format!("CAST({} AS CHAR) LIKE ?", quote_id(&c.name)))
                .collect();
            clauses.push(format!("({})", parts.join(" OR ")));
            for _ in &text_columns {
                values.push(Value::Bytes(format!("%{search}%").into_bytes()));
            }
        }
    }
    if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    }
}

pub async fn get_table_data(state: &AppState, payload: TableDataPayload) -> Result<TableData, String> {
    let session = state.session(&payload.session_id)?;
    let columns = list_columns(state, &payload.session_id, &payload.database, &payload.table).await?;
    let primary_keys: Vec<String> = columns.iter().filter(|c| c.column_key == "PRI").map(|c| c.name.clone()).collect();
    let mut values: Vec<Value> = Vec::new();
    let where_sql = build_where(&payload.filters, &payload.search, &columns, &mut values);
    let mut order_sql = String::new();
    if let Some(order_by) = payload.order_by.as_ref().filter(|c| columns.iter().any(|col| &col.name == *c)) {
        let dir = if payload.order_dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
        order_sql = format!(" ORDER BY {} {}", quote_id(order_by), dir);
    } else if !primary_keys.is_empty() {
        order_sql = format!(" ORDER BY {}", primary_keys.iter().map(|k| quote_id(k)).collect::<Vec<_>>().join(", "));
    }
    let limit = payload.limit.clamp(1, 2000);
    let offset = payload.offset;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT * FROM {}{} {} LIMIT ? OFFSET ?",
        qualify(&payload.database, &payload.table),
        where_sql,
        order_sql
    );
    let mut params = values.clone();
    params.push(Value::UInt(limit as u64));
    params.push(Value::UInt(offset as u64));
    let mut result = conn
        .exec_iter(&sql, Params::Positional(params))
        .await
        .map_err(|e| e.to_string())?;
    let columns_meta = serialize_columns(result.columns_ref());
    let mut rows = Vec::new();
    while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
        rows.push(serialize_row(&row));
    }
    drop(result);
    // The row count is fetched separately (`count_rows`) so the grid can paint as
    // soon as the page arrives instead of waiting for a potentially slow COUNT(*).
    Ok(TableData {
        columns: columns_meta,
        rows,
        total: None,
        limit,
        offset,
        primary_keys,
        column_meta: columns,
        order_by: payload.order_by,
        order_dir: payload.order_dir,
    })
}

pub async fn count_rows(state: &AppState, payload: TableDataPayload) -> Result<Option<u64>, String> {
    let session = state.session(&payload.session_id)?;
    let columns = list_columns(state, &payload.session_id, &payload.database, &payload.table).await?;
    let mut values: Vec<Value> = Vec::new();
    let where_sql = build_where(&payload.filters, &payload.search, &columns, &mut values);
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT COUNT(*) FROM {}{}",
        qualify(&payload.database, &payload.table),
        where_sql
    );
    let future = conn.exec::<Row, _, _>(&sql, Params::Positional(values));
    match tokio::time::timeout(Duration::from_secs(6), future).await {
        Ok(Ok(rows)) => Ok(Some(rows.first().map(|row| value_u64(row, 0)).unwrap_or(0))),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Ok(None),
    }
}

/// Every column of every table in one database, used by SQL autocompletion.
pub async fn all_columns(
    state: &AppState,
    session_id: &str,
    database: &str,
) -> Result<std::collections::HashMap<String, Vec<ColumnInfo>>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .exec::<Row, _, _>(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, \
             EXTRA, COLUMN_KEY, COLUMN_COMMENT, ORDINAL_POSITION, CHARACTER_SET_NAME, \
             COLLATION_NAME, COALESCE(GENERATION_EXPRESSION,'') \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, ORDINAL_POSITION",
            Params::Positional(vec![Value::Bytes(database.as_bytes().to_vec())]),
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut map: std::collections::HashMap<String, Vec<ColumnInfo>> = std::collections::HashMap::new();
    for row in rows {
        let table = value_string(&row, 0);
        map.entry(table).or_default().push(ColumnInfo {
            name: value_string(&row, 1),
            column_type: value_string(&row, 2),
            data_type: value_string(&row, 3),
            nullable: value_string(&row, 4),
            default_value: value_opt(&row, 5),
            extra: value_string(&row, 6),
            column_key: value_string(&row, 7),
            comment: value_string(&row, 8),
            position: value_i64(&row, 9),
            charset: value_opt(&row, 10),
            collation: value_opt(&row, 11),
            generation_expression: value_string(&row, 12),
        });
    }
    Ok(map)
}

fn json_param(value: &Json) -> Value {
    match value {
        Json::Null => Value::NULL,
        Json::String(s) => Value::Bytes(s.as_bytes().to_vec()),
        Json::Bool(v) => Value::Int(if *v { 1 } else { 0 }),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() { Value::Int(i) }
            else if let Some(u) = n.as_u64() { Value::UInt(u) }
            else { Value::Double(n.as_f64().unwrap_or(0.0)) }
        }
        _ => Value::Bytes(value.to_string().into_bytes()),
    }
}

pub async fn update_cell(state: &AppState, payload: UpdateCellPayload) -> Result<u64, String> {
    state.ensure_writable(&payload.session_id)?;
    let session = state.session(&payload.session_id)?;
    let details = get_table_details(state, &payload.session_id, &payload.database, &payload.table).await?;
    if details.primary_keys.is_empty() {
        return Err("这张表没有主键，已禁用行内编辑".into());
    }
    if !details.columns.iter().any(|c| c.name == payload.column) {
        return Err("未知列".into());
    }
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut params = vec![json_param(&payload.value)];
    let mut conditions = Vec::new();
    for key in &details.primary_keys {
        let value = payload.keys.get(key).ok_or_else(|| "缺少主键值".to_string())?;
        conditions.push(format!("{} = ?", quote_id(key)));
        params.push(json_param(value));
    }
    let sql = format!(
        "UPDATE {} SET {} = ? WHERE {} LIMIT 1",
        qualify(&payload.database, &payload.table),
        quote_id(&payload.column),
        conditions.join(" AND ")
    );
    conn.exec_drop(sql, Params::Positional(params)).await.map_err(|e| e.to_string())?;
    Ok(conn.affected_rows())
}

pub async fn update_cells(state: &AppState, payload: UpdateCellsPayload) -> Result<u64, String> {
    state.ensure_writable(&payload.session_id)?;
    if payload.rows.is_empty() {
        return Ok(0);
    }
    let session = state.session(&payload.session_id)?;
    let details = get_table_details(state, &payload.session_id, &payload.database, &payload.table).await?;
    if details.primary_keys.is_empty() {
        return Err("这张表没有主键，已禁用批量更新".into());
    }
    if !details.columns.iter().any(|column| column.name == payload.column) {
        return Err("未知列".into());
    }
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut tx = conn.start_transaction(TxOpts::default()).await.map_err(|e| e.to_string())?;
    let mut affected = 0u64;
    for keys in &payload.rows {
        let mut params = vec![json_param(&payload.value)];
        let mut conditions = Vec::new();
        for key in &details.primary_keys {
            let value = keys.get(key).ok_or_else(|| "缺少主键值".to_string())?;
            conditions.push(format!("{} = ?", quote_id(key)));
            params.push(json_param(value));
        }
        let sql = format!(
            "UPDATE {} SET {} = ? WHERE {} LIMIT 1",
            qualify(&payload.database, &payload.table),
            quote_id(&payload.column),
            conditions.join(" AND ")
        );
        match tx.exec_drop(sql, Params::Positional(params)).await {
            Ok(_) => affected += tx.affected_rows(),
            Err(error) => {
                let _ = tx.rollback().await;
                return Err(error.to_string());
            }
        }
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(affected)
}

pub async fn delete_rows(state: &AppState, payload: DeleteRowsPayload) -> Result<u64, String> {
    state.ensure_writable(&payload.session_id)?;
    let session = state.session(&payload.session_id)?;
    let details = get_table_details(state, &payload.session_id, &payload.database, &payload.table).await?;
    if details.primary_keys.is_empty() {
        return Err("这张表没有主键，已禁用删除".into());
    }
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut deleted = 0u64;
    let mut tx = conn.start_transaction(TxOpts::default()).await.map_err(|e| e.to_string())?;
    for keys in &payload.rows {
        let mut params = Vec::new();
        let mut conditions = Vec::new();
        for key in &details.primary_keys {
            let value = keys.get(key).ok_or_else(|| "缺少主键值".to_string())?;
            conditions.push(format!("{} = ?", quote_id(key)));
            params.push(json_param(value));
        }
        let sql = format!(
            "DELETE FROM {} WHERE {} LIMIT 1",
            qualify(&payload.database, &payload.table),
            conditions.join(" AND ")
        );
        match tx.exec_drop(sql, Params::Positional(params)).await {
            Ok(_) => deleted += tx.affected_rows(),
            Err(err) => {
                let _ = tx.rollback().await;
                return Err(err.to_string());
            }
        }
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(deleted)
}

pub async fn insert_row(state: &AppState, payload: InsertRowPayload) -> Result<(String, u64), String> {
    state.ensure_writable(&payload.session_id)?;
    let session = state.session(&payload.session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let entries: Vec<(&String, &Json)> = payload.values.iter().collect();
    let sql = if entries.is_empty() {
        format!("INSERT INTO {} () VALUES ()", qualify(&payload.database, &payload.table))
    } else {
        format!(
            "INSERT INTO {} ({}) VALUES ({})",
            qualify(&payload.database, &payload.table),
            entries.iter().map(|(k, _)| quote_id(k)).collect::<Vec<_>>().join(", "),
            entries.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
        )
    };
    let params: Vec<Value> = entries.iter().map(|(_, value)| json_param(value)).collect();
    conn.exec_drop(sql, Params::Positional(params)).await.map_err(|e| e.to_string())?;
    let insert_id = conn.last_insert_id().map(|v| v.to_string()).unwrap_or_default();
    Ok((insert_id, conn.affected_rows()))
}

pub async fn server_overview(state: &AppState, session_id: &str) -> Result<ServerOverview, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let status_rows = conn.query::<Row, _>("SHOW GLOBAL STATUS").await.map_err(|e| e.to_string())?;
    let mut status = std::collections::HashMap::new();
    for row in &status_rows {
        status.insert(value_string(row, 0), value_string(row, 1));
    }
    let var_rows = conn
        .query::<Row, _>(
            "SHOW GLOBAL VARIABLES WHERE Variable_name IN \
             ('version','character_set_server','collation_server','hostname','max_connections','innodb_buffer_pool_size')",
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut variables = std::collections::HashMap::new();
    for row in &var_rows {
        variables.insert(value_string(row, 0), value_string(row, 1));
    }
    let uptime = status.get("Uptime").and_then(|v| v.parse().ok()).unwrap_or(0);
    let queries = status.get("Queries").and_then(|v| v.parse().ok()).unwrap_or(0);
    let status_struct = ServerStatus {
        uptime,
        threads_connected: status.get("Threads_connected").and_then(|v| v.parse().ok()).unwrap_or(0),
        threads_running: status.get("Threads_running").and_then(|v| v.parse().ok()).unwrap_or(0),
        queries,
        slow_queries: status.get("Slow_queries").and_then(|v| v.parse().ok()).unwrap_or(0),
        bytes_received: status.get("Bytes_received").and_then(|v| v.parse().ok()).unwrap_or(0),
        bytes_sent: status.get("Bytes_sent").and_then(|v| v.parse().ok()).unwrap_or(0),
        aborted_connects: status.get("Aborted_connects").and_then(|v| v.parse().ok()).unwrap_or(0),
        max_used_connections: status.get("Max_used_connections").and_then(|v| v.parse().ok()).unwrap_or(0),
        qps_avg: if uptime > 0 { queries as f64 / uptime as f64 } else { 0.0 },
        questions: status.get("Questions").and_then(|v| v.parse().ok()).unwrap_or(0),
        innodb_buffer_pool_size: variables.get("innodb_buffer_pool_size").and_then(|v| v.parse().ok()).unwrap_or(0),
    };
    let stats_row = conn
        .query_first::<Row, _>(
            "SELECT COUNT(DISTINCT TABLE_SCHEMA), COALESCE(SUM(TABLE_ROWS),0), COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')",
        )
        .await
        .map_err(|e| e.to_string())?;
    let database_stats = stats_row
        .map(|row| json!({
            "schemaCount": value_u64(&row, 0),
            "rowEstimate": value_u64(&row, 1),
            "bytes": value_u64(&row, 2),
        }))
        .unwrap_or_else(|| json!({"schemaCount":0,"rowEstimate":0,"bytes":0}));
    let top_rows = conn
        .query::<Row, _>(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COALESCE(DATA_LENGTH+INDEX_LENGTH,0), COALESCE(TABLE_ROWS,0) \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
             ORDER BY COALESCE(DATA_LENGTH+INDEX_LENGTH,0) DESC LIMIT 8",
        )
        .await
        .unwrap_or_default();
    let top_tables: Vec<Json> = top_rows
        .iter()
        .map(|row| json!({
            "db": value_string(row, 0),
            "name": value_string(row, 1),
            "bytes": value_u64(row, 2),
            "rowsEstimate": value_u64(row, 3),
        }))
        .collect();
    let processes = list_processes(state, session_id).await.unwrap_or_default();
    let replication = conn
        .query::<Row, _>("SHOW REPLICA STATUS")
        .await
        .ok()
        .and_then(|rows| rows.first().map(|row| {
            let mut map = serde_json::Map::new();
            for (i, column) in row.columns_ref().iter().enumerate() {
                map.insert(column.name_str().to_string(), json!(mysql_to_text(row.as_ref(i))));
            }
            Json::Object(map)
        }));
    Ok(ServerOverview {
        version: session.version.clone(),
        variables,
        status: status_struct,
        database_stats,
        top_tables,
        processes,
        replication,
        sampled_at: chrono::Utc::now().timestamp_millis(),
    })
}

pub async fn list_processes(state: &AppState, session_id: &str) -> Result<Vec<ProcessInfo>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn
        .query::<Row, _>(
            "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO FROM information_schema.PROCESSLIST ORDER BY TIME DESC LIMIT 100",
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ProcessInfo {
            id: value_u64(row, 0),
            user: value_string(row, 1),
            host: value_string(row, 2),
            db: value_opt(row, 3),
            command: value_string(row, 4),
            time: value_u64(row, 5),
            state: value_opt(row, 6),
            info: value_string(row, 7).chars().take(500).collect(),
        })
        .collect())
}

pub async fn kill_process(state: &AppState, session_id: &str, thread_id: u64) -> Result<bool, String> {
    state.ensure_writable(session_id)?;
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("KILL {thread_id}")).await.map_err(|e| e.to_string())?;
    Ok(true)
}

pub async fn server_variables(state: &AppState, session_id: &str) -> Result<Vec<Json>, String> {
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let rows = conn.query::<Row, _>("SHOW GLOBAL VARIABLES").await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| json!({"Variable_name": value_string(row, 0), "Value": value_string(row, 1)}))
        .collect())
}

pub async fn explain(
    state: &AppState,
    session_id: &str,
    database: &str,
    sql: &str,
) -> Result<Json, String> {
    let statements = crate::sql::split_statements(sql);
    if statements.len() != 1 || !matches!(crate::sql::first_keyword(&statements[0]).as_str(), "SELECT" | "WITH" | "TABLE") {
        return Err("EXPLAIN 只支持一条 SELECT 查询".into());
    }
    crate::sql::validate_read_only(&statements[0])?;
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    if !database.is_empty() {
        conn.query_drop(format!("USE {}", quote_id(database))).await.map_err(|e| e.to_string())?;
    }
    let clean = &statements[0];
    let mut result = conn.query_iter(format!("EXPLAIN {clean}")).await.map_err(|e| e.to_string())?;
    let columns = serialize_columns(result.columns_ref());
    let mut rows = Vec::new();
    while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
        rows.push(serialize_row(&row));
    }
    drop(result);
    let json_plan = conn
        .query_first::<Row, _>(format!("EXPLAIN FORMAT=JSON {clean}"))
        .await
        .ok()
        .flatten()
        .map(|row| mysql_to_text(row.as_ref(0)));
    Ok(json!({
        "columns": columns,
        "rows": rows,
        "json": json_plan,
    }))
}
