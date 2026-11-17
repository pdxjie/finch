use std::collections::HashSet;

use mysql_async::prelude::*;

use crate::db::{qualify, quote_id, AppState};
use crate::models::*;

fn valid_ident(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn valid_type(value: &str) -> bool {
    let lower = value.to_lowercase();
    !value.is_empty()
        && value.len() <= 120
        && !lower.contains(';')
        && !lower.contains("--")
        && !lower.contains("/*")
        && !lower.contains("drop ")
        && !lower.contains("alter ")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " _(),'+-".contains(c))
}

fn default_sql(value: &Option<String>) -> String {
    match value.as_deref().map(str::trim) {
        None => String::new(),
        Some("") => " DEFAULT ''".into(),
        Some("NULL") | Some("null") => " DEFAULT NULL".into(),
        Some(v) if v.eq_ignore_ascii_case("CURRENT_TIMESTAMP") => " DEFAULT CURRENT_TIMESTAMP".into(),
        Some(v) if v.eq_ignore_ascii_case("CURRENT_TIMESTAMP()") => " DEFAULT CURRENT_TIMESTAMP()".into(),
        Some(v) if v.eq_ignore_ascii_case("CURRENT_TIMESTAMP(3)") => " DEFAULT CURRENT_TIMESTAMP(3)".into(),
        Some(v) if v.eq_ignore_ascii_case("CURRENT_TIMESTAMP(6)") => " DEFAULT CURRENT_TIMESTAMP(6)".into(),
        Some(v) if v.eq_ignore_ascii_case("CURRENT_DATE") => " DEFAULT (CURRENT_DATE)".into(),
        Some(v) if v.eq_ignore_ascii_case("CURRENT_TIME") => " DEFAULT (CURRENT_TIME)".into(),
        Some(v) if v.parse::<f64>().is_ok() => format!(" DEFAULT {v}"),
        Some(v) => format!(" DEFAULT '{}'", v.replace('\\', "\\\\").replace('\'', "''")),
    }
}

fn column_sql(column: &DdlColumn, for_alter: bool) -> Result<String, String> {
    if !valid_ident(&column.name) {
        return Err(format!("字段名不合法: {}", column.name));
    }
    if !valid_type(&column.column_type) {
        return Err(format!("字段类型不合法: {}", column.column_type));
    }
    let mut sql = format!("{} {}", quote_id(&column.name), column.column_type.trim());
    sql.push_str(if column.nullable { " NULL" } else { " NOT NULL" });
    sql.push_str(&default_sql(&column.default_value));
    if column.auto_increment {
        sql.push_str(" AUTO_INCREMENT");
    }
    if !column.comment.trim().is_empty() {
        sql.push_str(&format!(
            " COMMENT '{}'",
            column.comment.replace('\\', "\\\\").replace('\'', "''")
        ));
    }
    if for_alter {
        if let Some(after) = column.after.as_ref().filter(|a| !a.trim().is_empty()) {
            if !valid_ident(after) {
                return Err(format!("AFTER 字段名不合法: {after}"));
            }
            sql.push_str(&format!(" AFTER {}", quote_id(after)));
        }
    }
    Ok(sql)
}


fn index_kind(index: &DdlIndex) -> Result<&'static str, String> {
    let kind = index.index_type.to_uppercase();
    match kind.as_str() {
        "" | "BTREE" => Ok(if index.unique { "UNIQUE KEY" } else { "KEY" }),
        "HASH" => Ok(if index.unique { "UNIQUE KEY" } else { "KEY" }),
        "FULLTEXT" => Ok("FULLTEXT KEY"),
        "SPATIAL" => Ok("SPATIAL KEY"),
        other => Err(format!("不支持的索引类型: {other}")),
    }
}

fn index_sql(index: &DdlIndex) -> Result<String, String> {
    let columns = index
        .columns
        .iter()
        .map(|column| column.trim())
        .filter(|column| !column.is_empty())
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err(format!("索引 {} 还没有选择字段", index_label(index)));
    }
    for column in &columns {
        if !valid_ident(column) {
            return Err(format!("索引字段名不合法: {column}"));
        }
    }
    let name = index_name(index);
    if !valid_ident(&name) {
        return Err(format!("索引名不合法: {name}"));
    }
    let kind = index_kind(index)?;
    let cols = columns.iter().map(|column| quote_id(column)).collect::<Vec<_>>().join(", ");
    let mut suffix = String::new();
    if kind == "FULLTEXT KEY" || kind == "SPATIAL KEY" {
        // FULLTEXT/SPATIAL do not accept USING BTREE.
    } else if index.index_type.eq_ignore_ascii_case("HASH") {
        suffix.push_str(" USING HASH");
    }
    Ok(format!("{kind} {}{suffix} ({cols})", quote_id(&name)))
}

fn index_label(index: &DdlIndex) -> String {
    if index.name.trim().is_empty() {
        index.columns.join("_")
    } else {
        index.name.clone()
    }
}

fn index_name(index: &DdlIndex) -> String {
    let raw = index.name.trim();
    if !raw.is_empty() {
        return raw.to_string();
    }
    let joined = index
        .columns
        .iter()
        .map(|column| column.trim())
        .filter(|column| !column.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let prefix = if index.unique { "uniq" } else { "idx" };
    format!("{prefix}_{joined}").chars().take(60).collect()
}

fn validate_index_columns(indexes: &[DdlIndex], columns: &HashSet<String>) -> Result<(), String> {
    for index in indexes {
        for column in &index.columns {
            if column.trim().is_empty() {
                continue;
            }
            if !columns.contains(column.trim()) {
                return Err(format!("索引 {} 引用了不存在的字段: {column}", index_label(index)));
            }
        }
    }
    Ok(())
}

fn safe_option(value: &str, fallback: &str) -> String {
    if valid_ident(value) { value.to_string() } else { fallback.to_string() }
}

pub async fn create_table(state: &AppState, request: CreateTableRequest) -> Result<String, String> {
    state.ensure_writable(&request.session_id)?;
    if !valid_ident(&request.table) {
        return Err("表名只能包含字母、数字、下划线和 $，且不超过 64 字符".into());
    }
    if request.columns.is_empty() {
        return Err("至少需要一个字段".into());
    }
    let session = state.session(&request.session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let mut parts: Vec<String> = Vec::new();
    let mut primary: Vec<String> = Vec::new();
    let mut names: HashSet<String> = HashSet::new();
    for column in &request.columns {
        if !names.insert(column.name.clone()) {
            return Err(format!("字段名重复: {}", column.name));
        }
        parts.push(column_sql(column, false)?);
        if column.primary {
            primary.push(quote_id(&column.name));
        }
    }
    if !primary.is_empty() {
        parts.push(format!("PRIMARY KEY ({})", primary.join(", ")));
    }
    let mut index_names: HashSet<String> = HashSet::new();
    validate_index_columns(&request.indexes, &names)?;
    for index in &request.indexes {
        let name = index_name(index);
        if !index_names.insert(name.to_lowercase()) {
            return Err(format!("索引名重复: {name}"));
        }
        parts.push(index_sql(index)?);
    }
    let engine = safe_option(&request.engine, "InnoDB");
    let charset = safe_option(&request.charset, "utf8mb4");
    let sql = format!(
        "CREATE TABLE {} (\n  {}\n) ENGINE={} DEFAULT CHARSET={}",
        qualify(&request.database, &request.table),
        parts.join(",\n  "),
        engine,
        charset
    );
    conn.query_drop(&sql).await.map_err(|e| format!("建表失败: {e}"))?;
    Ok(sql)
}

pub async fn alter_table(state: &AppState, request: AlterTableRequest) -> Result<String, String> {
    state.ensure_writable(&request.session_id)?;
    if !valid_ident(&request.table) {
        return Err("表名不合法".into());
    }
    let session = state.session(&request.session_id)?;
    let mut result_columns: HashSet<String> = crate::schema::list_columns(
        state,
        &request.session_id,
        &request.database,
        &request.table,
    )
    .await?
    .into_iter()
    .map(|column| column.name)
    .collect();
    for column in request.drop_columns.iter().filter(|column| valid_ident(column)) {
        result_columns.remove(column);
    }
    for column in &request.add {
        result_columns.insert(column.name.clone());
    }
    validate_index_columns(&request.add_indexes, &result_columns)?;
    validate_index_columns(&request.modify_indexes, &result_columns)?;

    let mut clauses: Vec<String> = Vec::new();
    for column in &request.add {
        clauses.push(format!("ADD COLUMN {}", column_sql(column, true)?));
    }
    for column in &request.modify {
        clauses.push(format!("MODIFY COLUMN {}", column_sql(column, true)?));
    }
    for column in &request.drop_columns {
        if !valid_ident(column) {
            return Err(format!("字段名不合法: {column}"));
        }
        clauses.push(format!("DROP COLUMN {}", quote_id(column)));
    }
    for name in &request.drop_indexes {
        if name.eq_ignore_ascii_case("PRIMARY") {
            return Err("主键请通过字段设置修改".into());
        }
        if !valid_ident(name) {
            return Err(format!("索引名不合法: {name}"));
        }
        clauses.push(format!("DROP INDEX {}", quote_id(name)));
    }
    for index in &request.modify_indexes {
        let name = if index.name.trim().is_empty() {
            return Err("修改索引时必须保留索引名".into());
        } else {
            index.name.trim()
        };
        clauses.push(format!("DROP INDEX {}", quote_id(name)));
        clauses.push(format!("ADD {}", index_sql(index)?));
    }
    for index in &request.add_indexes {
        clauses.push(format!("ADD {}", index_sql(index)?));
    }
    if let Some(rename) = request.rename_to.as_ref().filter(|r| !r.trim().is_empty()) {
        if !valid_ident(rename) {
            return Err("新表名不合法".into());
        }
        clauses.push(format!("RENAME TO {}", quote_id(rename)));
    }
    if clauses.is_empty() {
        return Err("没有需要修改的内容".into());
    }
    let sql = format!(
        "ALTER TABLE {} {}",
        qualify(&request.database, &request.table),
        clauses.join(", ")
    );
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(&sql).await.map_err(|e| format!("修改表失败: {e}"))?;
    Ok(sql)
}

pub async fn drop_table(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    state.ensure_writable(session_id)?;
    if !valid_ident(table) {
        return Err("表名不合法".into());
    }
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let sql = format!("DROP TABLE {}", qualify(database, table));
    conn.query_drop(&sql).await.map_err(|e| format!("删除表失败: {e}"))?;
    Ok(sql)
}
