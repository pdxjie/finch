use std::fs::{create_dir_all, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use mysql_async::prelude::*;
use mysql_async::Value;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::db::{qualify, quote_id, AppState};
use crate::models::*;
use crate::schema;

fn sql_literal(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::NULL) => "NULL".into(),
        Some(Value::Int(v)) => v.to_string(),
        Some(Value::UInt(v)) => v.to_string(),
        Some(Value::Float(v)) => v.to_string(),
        Some(Value::Double(v)) => v.to_string(),
        Some(Value::Date(y, m, d, h, mi, s, _)) => format!("'{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}'"),
        Some(Value::Time(neg, days, h, mi, s, _)) => {
            format!("'{}{days} {h:02}:{mi:02}:{s:02}'", if *neg { "-" } else { "" })
        }
        Some(Value::Bytes(bytes)) => match std::str::from_utf8(bytes) {
            Ok(text) => format!(
                "'{}'",
                text.replace('\\', "\\\\")
                    .replace('\'', "''")
                    .replace('\n', "\\n")
                    .replace('\r', "\\r")
                    .replace('\0', "\\0")
            ),
            Err(_) => format!("X'{}'", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()),
        },
    }
}

fn write_header(writer: &mut BufWriter<File>, database: &str) -> Result<(), String> {
    writeln!(
        writer,
        "-- Finch dump\n-- database: {database}\n-- created: {}\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nUSE {};\n",
        chrono::Utc::now().to_rfc3339(),
        quote_id(database)
    )
    .map_err(|e| e.to_string())
}

fn write_footer(writer: &mut BufWriter<File>) -> Result<(), String> {
    writeln!(writer, "\nSET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;").map_err(|e| e.to_string())
}

async fn write_table(
    conn: &mut mysql_async::Conn,
    database: &str,
    table: &str,
    structure: bool,
    data: bool,
    writer: &mut BufWriter<File>,
) -> Result<(), String> {
    if structure {
        let ddl = conn
            .query::<mysql_async::Row, _>(format!("SHOW CREATE TABLE {}", qualify(database, table)))
            .await
            .ok()
            .and_then(|rows| rows.first().and_then(|row| row.as_ref(1).map(|v| crate::db::mysql_to_text(Some(v)))))
            .unwrap_or_default();
        if !ddl.is_empty() {
            writeln!(writer, "\n--\n-- Table structure for `{table}`\n--\n").map_err(|e| e.to_string())?;
            writeln!(writer, "DROP TABLE IF EXISTS {};", quote_id(table)).map_err(|e| e.to_string())?;
            writeln!(writer, "{ddl};\n").map_err(|e| e.to_string())?;
        }
    }
    if data {
        let sql = format!("SELECT * FROM {}", qualify(database, table));
        let mut result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
        let columns = result.columns_ref().to_vec();
        if columns.is_empty() {
            return Ok(());
        }
        let column_names = columns
            .iter()
            .map(|c| quote_id(&c.name_str()))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(writer, "\n--\n-- Data for `{table}`\n--\nLOCK TABLES {} WRITE;", quote_id(table))
            .map_err(|e| e.to_string())?;
        let mut batch = 0;
        while let Some(row) = result.next().await.map_err(|e| e.to_string())? {
            let values = (0..row.len()).map(|i| sql_literal(row.as_ref(i))).collect::<Vec<_>>().join(", ");
            if batch % 100 == 0 {
                write!(writer, "\nINSERT INTO {} ({column_names}) VALUES\n", quote_id(table)).map_err(|e| e.to_string())?;
            } else {
                write!(writer, ",\n").map_err(|e| e.to_string())?;
            }
            write!(writer, "({values})").map_err(|e| e.to_string())?;
            batch += 1;
            if batch % 100 == 0 {
                write!(writer, ";").map_err(|e| e.to_string())?;
            }
        }
        if batch % 100 != 0 {
            write!(writer, ";").map_err(|e| e.to_string())?;
        }
        writeln!(writer, "\nUNLOCK TABLES;").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn table_file_name(table: &str) -> String {
    let safe: String = table
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    format!("{safe}.sql")
}

fn progress(app: Option<&AppHandle>, table: &str, index: usize, total: usize) {
    if let Some(app) = app {
        let _ = app.emit(
            "finch://event",
            json!({"type":"dump:progress","table":table,"index":index,"total":total}),
        );
    }
}

pub async fn dump(app: Option<&AppHandle>, state: &AppState, request: DumpRequest) -> Result<serde_json::Value, String> {
    if !request.structure && !request.data {
        return Err("请选择导出结构或数据".into());
    }
    let session = state.session(&request.session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    conn.query_drop(format!("USE {}", quote_id(&request.database)))
        .await
        .map_err(|e| e.to_string())?;
    let tables = schema::list_tables(state, &request.session_id, &request.database, "table").await?;
    let selected: Vec<String> = if request.tables.is_empty() {
        tables.iter().map(|t| t.name.clone()).collect()
    } else {
        request.tables.clone()
    };

    if request.split_files {
        let dir = PathBuf::from(&request.path);
        create_dir_all(&dir).map_err(|e| format!("无法创建目录: {e}"))?;
        let mut files = Vec::new();
        for (index, table) in selected.iter().enumerate() {
            progress(app, table, index, selected.len());
            let path = dir.join(table_file_name(table));
            let mut writer = BufWriter::new(File::create(&path).map_err(|e| format!("无法创建文件: {e}"))?);
            write_header(&mut writer, &request.database)?;
            write_table(&mut conn, &request.database, table, request.structure, request.data, &mut writer).await?;
            write_footer(&mut writer)?;
            writer.flush().map_err(|e| e.to_string())?;
            files.push(path.to_string_lossy().to_string());
        }
        return Ok(json!({
            "saved": true,
            "path": request.path,
            "tables": selected.len(),
            "files": files,
            "split": true,
        }));
    }

    let mut writer = BufWriter::new(File::create(&request.path).map_err(|e| format!("无法创建文件: {e}"))?);
    write_header(&mut writer, &request.database)?;
    for (index, table) in selected.iter().enumerate() {
        progress(app, table, index, selected.len());
        write_table(&mut conn, &request.database, table, request.structure, request.data, &mut writer).await?;
    }
    write_footer(&mut writer)?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(json!({
        "saved": true,
        "path": request.path,
        "tables": selected.len(),
        "files": [request.path.clone()],
        "split": false,
    }))
}
