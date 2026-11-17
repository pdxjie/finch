use std::collections::HashMap;

use mysql_async::prelude::*;
use serde_json::{json, Value};

use crate::db::AppState;
use crate::models::*;
use crate::store;

fn normalize_protocol(provider: &mut AiProvider) {
    let protocol = provider.protocol.trim().to_lowercase();
    provider.protocol = match protocol.as_str() {
        "chat" | "responses" | "anthropic" => protocol,
        _ if provider.kind == "anthropic" => "anthropic".into(),
        _ => "chat".into(),
    };
}

fn normalize_provider(mut provider: AiProvider) -> AiProvider {
    normalize_protocol(&mut provider);
    if provider.id.trim().is_empty() {
        provider.id = uuid::Uuid::new_v4().to_string();
    }
    if provider.name.trim().is_empty() {
        provider.name = match provider.kind.as_str() {
            "anthropic" => "Anthropic".into(),
            "deepseek" => "DeepSeek".into(),
            "openai" => "OpenAI".into(),
            _ => "Custom provider".into(),
        };
    }
    if provider.base_url.trim().is_empty() {
        provider.base_url = match provider.kind.as_str() {
            "anthropic" => "https://api.anthropic.com/v1".into(),
            "deepseek" => "https://api.deepseek.com/v1".into(),
            _ => "https://api.openai.com/v1".into(),
        };
    }
    if provider.model.trim().is_empty() {
        provider.model = match provider.kind.as_str() {
            "anthropic" => "claude-sonnet-4-20250514".into(),
            "deepseek" => "deepseek-chat".into(),
            _ => "gpt-4.1-mini".into(),
        };
    }
    provider
}

pub fn list(state: &AppState) -> Vec<AiProvider> {
    let mut providers = state.ai_providers.lock().unwrap().clone();
    for provider in &mut providers {
        normalize_protocol(provider);
        provider.has_key = store::ai_secret(&provider.id).is_some();
    }
    providers
}

pub fn save(state: &AppState, input: AiProviderInput) -> Result<AiProvider, String> {
    let mut provider = normalize_provider(input.provider);
    if let Some(key) = input.api_key {
        if key.trim().is_empty() {
            // keep existing key
        } else {
            store::set_ai_secret(&provider.id, key.trim())?;
        }
    }
    provider.has_key = store::ai_secret(&provider.id).is_some();
    let mut providers = state.ai_providers.lock().unwrap();
    if let Some(existing) = providers.iter_mut().find(|p| p.id == provider.id) {
        *existing = provider.clone();
    } else {
        providers.push(provider.clone());
    }
    store::save_ai_providers(&providers)?;
    Ok(provider)
}

pub fn delete(state: &AppState, id: &str) -> Result<bool, String> {
    store::set_ai_secret(id, "")?;
    let mut providers = state.ai_providers.lock().unwrap();
    providers.retain(|p| p.id != id);
    store::save_ai_providers(&providers)?;
    Ok(true)
}

#[derive(Clone, Debug)]
struct SchemaColumn {
    name: String,
    column_type: String,
    key: String,
    comment: String,
}

#[derive(Clone, Debug)]
struct SchemaTable {
    name: String,
    kind: String,
    comment: String,
    columns: Vec<SchemaColumn>,
}

fn search_tokens(prompt: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for (phrase, aliases) in [
        ("订单", &["order", "orders", "purchase"][..]),
        ("发货单", &["shipment", "shipping", "delivery", "dispatch", "outbound"][..]),
        ("物流", &["logistics", "shipment", "shipping", "tracking"][..]),
        ("出库单", &["outbound", "shipment", "delivery", "warehouse"][..]),
        ("客户", &["customer", "client", "buyer"][..]),
        ("商品", &["product", "goods", "item", "sku"][..]),
    ] {
        if prompt.contains(phrase) {
            tokens.push(phrase.to_string());
            tokens.extend(aliases.iter().map(|item| (*item).to_string()));
        }
    }
    let mut ascii = String::new();
    for ch in prompt.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            ascii.push(ch.to_ascii_lowercase());
        } else if !ascii.is_empty() {
            if ascii.len() >= 2 { tokens.push(std::mem::take(&mut ascii)); } else { ascii.clear(); }
        }
    }
    if ascii.len() >= 2 { tokens.push(ascii); }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn schema_score(table: &SchemaTable, tokens: &[String]) -> i32 {
    let table_name = table.name.to_ascii_lowercase();
    let table_comment = table.comment.to_ascii_lowercase();
    tokens.iter().map(|token| {
        let mut score = 0;
        if table_name.contains(token) { score += 14; }
        if table_comment.contains(token) { score += 10; }
        for column in &table.columns {
            if column.name.to_ascii_lowercase().contains(token) { score += 8; }
            if column.comment.to_ascii_lowercase().contains(token) { score += 6; }
        }
        score
    }).sum()
}

fn ranked_table_names(tables: &[SchemaTable], prompt: &str, limit: usize) -> Vec<String> {
    let tokens = search_tokens(prompt);
    let mut ranked = tables.iter().map(|table| (schema_score(table, &tokens), &table.name)).collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    ranked.into_iter().filter(|(score, _)| *score > 0).take(limit).map(|(_, name)| name.clone()).collect()
}

fn planner_catalog(database: &str, tables: &[SchemaTable]) -> String {
    let mut out = format!("DATABASE `{database}` TABLE CATALOG. Select only exact table names from this catalog:\n");
    for table in tables {
        if table.comment.is_empty() {
            out.push_str(&format!("- `{}` ({}) columns: ", table.name, table.kind));
        } else {
            out.push_str(&format!("- `{}` ({}; comment: {}) columns: ", table.name, table.kind, table.comment));
        }
        for (index, column) in table.columns.iter().take(40).enumerate() {
            if index > 0 { out.push_str(", "); }
            out.push_str(&column.name);
            if out.len() > 32_000 { break; }
        }
        if table.columns.len() > 40 { out.push_str(", …"); }
        out.push('\n');
        if out.len() > 32_000 { out.push_str("-- catalog truncated by size; use the exact names above.\n"); break; }
    }
    out
}

fn selected_schema_context(database: &str, tables: &[SchemaTable], selected_names: &[String]) -> String {
    let mut out = format!("DATABASE `{database}`\nSELECTED TABLES (read from the live database):\n");
    let mut columns_written = 0usize;
    for table in tables.iter().filter(|table| selected_names.iter().any(|name| name.eq_ignore_ascii_case(&table.name))) {
        out.push_str(&format!("\nTABLE `{}`", table.name));
        if !table.comment.is_empty() { out.push_str(&format!(" (comment: {})", table.comment)); }
        out.push_str(":\n");
        for column in &table.columns {
            if columns_written >= 900 { out.push_str("  -- column details truncated\n"); break; }
            out.push_str(&format!("  `{}` {}{}{}\n", column.name, column.column_type,
                if column.key == "PRI" { " PRIMARY KEY" } else if column.key == "UNI" { " UNIQUE" } else { "" },
                if column.comment.is_empty() { String::new() } else { format!(" COMMENT '{}';", column.comment) }));
            columns_written += 1;
        }
    }
    out.push_str("\n-- These definitions were selected from the live database catalog. Use only these exact names and columns.\n");
    out
}

fn planner_table_names(text: &str, tables: &[SchemaTable]) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    tables.iter().filter(|table| lower.contains(&table.name.to_ascii_lowercase())).map(|table| table.name.clone()).collect()
}

async fn load_schema_tables(state: &AppState, session_id: &str, database: &str) -> Result<Vec<SchemaTable>, String> {
    if database.trim().is_empty() {
        return Err("当前查询没有选择数据库，无法读取表结构".into());
    }
    let session = state.session(session_id)?;
    let mut conn = session.pool.get_conn().await.map_err(|e| e.to_string())?;
    let tables = conn
        .exec::<mysql_async::Row, _, _>(
            "SELECT TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_COMMENT,'') \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME",
            mysql_async::Params::Positional(vec![mysql_async::Value::Bytes(database.as_bytes().to_vec())]),
        )
        .await
        .map_err(|e| format!("读取数据库表目录失败: {e}"))?;
    let rows = conn
        .exec::<mysql_async::Row, _, _>(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, COALESCE(COLUMN_COMMENT,'') \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, ORDINAL_POSITION",
            mysql_async::Params::Positional(vec![mysql_async::Value::Bytes(database.as_bytes().to_vec())]),
        )
        .await
        .map_err(|e| format!("读取数据库列结构失败: {e}"))?;
    let mut grouped: HashMap<String, Vec<SchemaColumn>> = HashMap::new();
    for row in &rows {
        let table = crate::db::mysql_to_text(row.as_ref(0));
        grouped.entry(table).or_default().push(SchemaColumn {
            name: crate::db::mysql_to_text(row.as_ref(1)),
            column_type: crate::db::mysql_to_text(row.as_ref(2)),
            key: crate::db::mysql_to_text(row.as_ref(3)),
            comment: crate::db::mysql_to_text(row.as_ref(4)),
        });
    }
    let tables = tables.into_iter().map(|row| {
        let name = crate::db::mysql_to_text(row.as_ref(0));
        SchemaTable { columns: grouped.remove(&name).unwrap_or_default(), name,
            kind: crate::db::mysql_to_text(row.as_ref(1)), comment: crate::db::mysql_to_text(row.as_ref(2)) }
    }).collect();
    Ok(tables)
}

fn strip_sql(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("sql").unwrap_or(after).trim_start();
        if let Some(end) = after.find("```") {
            return after[..end].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn sql_or_comment(text: &str) -> String {
    let cleaned = strip_sql(text);
    if cleaned.trim().is_empty() {
        return "-- AI 未返回可执行 SQL".into();
    }
    let first = crate::sql::first_keyword(&cleaned);
    const SQL_KEYWORDS: &[&str] = &[
        "SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "TABLE", "VALUES",
        "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "TRUNCATE",
    ];
    if SQL_KEYWORDS.contains(&first.as_str()) {
        return cleaned;
    }
    cleaned.lines()
        .map(|line| if line.trim_start().starts_with("--") { line.to_string() } else { format!("-- {line}") })
        .collect::<Vec<_>>().join("\n")
}

fn text_from_chat(payload: &Value) -> String {
    payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("")
        .to_string()
}

fn text_from_anthropic(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(|content| content.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("type").and_then(|t| t.as_str()) != Some("thinking"))
                .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

pub(crate) fn text_from_responses(payload: &Value) -> String {
    if let Some(text) = payload.get("output_text").and_then(|value| value.as_str()) {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    payload
        .get("output")
        .and_then(|output| output.as_array())
        .map(|items| {
            items
                .iter()
                .flat_map(|item| {
                    item.get("content")
                        .and_then(|content| content.as_array())
                        .map(|parts| parts.as_slice())
                        .unwrap_or(&[])
                })
                .filter_map(|part| {
                    let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if kind == "output_text" || kind == "text" {
                        part.get("text").and_then(|text| text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn extract_text(protocol: &str, payload: &Value) -> String {
    match protocol {
        "anthropic" => text_from_anthropic(payload),
        "responses" => text_from_responses(payload),
        _ => text_from_chat(payload),
    }
}

fn build_request(
    protocol: &str,
    base: &str,
    model: &str,
    system: &str,
    user: &str,
    api_key: &str,
) -> (String, Value, Vec<(String, String)>) {
    let base = base.trim_end_matches('/');
    match protocol {
        "anthropic" => (
            if base.ends_with("/messages") {
                base.to_string()
            } else {
                format!("{base}/messages")
            },
            json!({
                "model": model,
                "max_tokens": 4096,
                "stream": true,
                "temperature": 0,
                "system": system,
                "messages": [{"role": "user", "content": user}]
            }),
            vec![
                ("x-api-key".to_string(), api_key.to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ],
        ),
        "responses" => (
            if base.ends_with("/responses") {
                base.to_string()
            } else {
                format!("{base}/responses")
            },
            json!({
                "model": model,
                "instructions": system,
                "stream": true,
                "store": false,
                "input": [{
                    "role": "user",
                    "content": [{"type": "input_text", "text": user}]
                }]
            }),
            vec![("Authorization".to_string(), format!("Bearer {api_key}"))],
        ),
        _ => (
            if base.ends_with("/chat/completions") {
                base.to_string()
            } else {
                format!("{base}/chat/completions")
            },
            json!({
                "model": model,
                "temperature": 0,
                "stream": true,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user}
                ]
            }),
            vec![("Authorization".to_string(), format!("Bearer {api_key}"))],
        ),
    }
}

async fn request_text(
    provider: &AiProvider,
    system: &str,
    user: &str,
    api_key: &str,
    mut on_delta: impl FnMut(&str) -> Result<(), String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let protocol = provider.protocol.as_str();
    let (url, body, headers) = build_request(protocol, &provider.base_url, &provider.model, system, user, api_key);
    let mut request = client.post(url)
        .header("Accept", "text/event-stream")
        .header("Accept-Encoding", "identity")
        .json(&body);
    for (key, value) in headers { request = request.header(key, value); }
    let mut response = request.send().await.map_err(|e| format!("AI 请求失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let payload: Value = response.json().await.map_err(|e| format!("AI 服务商返回 {status}，错误响应解析失败: {e}"))?;
        let message = payload["error"]["message"].as_str().or_else(|| payload["message"].as_str()).unwrap_or("未知错误");
        return Err(format!("AI 服务商返回 {status}: {message}"));
    }
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    // Some compatible services ignore stream=true and still return a JSON response.
    if content_type.contains("application/json") {
        let payload: Value = response.json().await.map_err(|e| format!("AI 响应解析失败: {e}"))?;
        let text = extract_text(protocol, &payload);
        if text.trim().is_empty() { return Err("AI 没有返回内容".into()); }
        on_delta(&text)?;
        return Ok(text);
    }
    let mut decoder = crate::ai_stream::Decoder::default();
    let mut text = String::new();
    let mut done = false;
    loop {
        let chunk = response.chunk().await.map_err(|e| format!("AI 流式连接中断（服务商响应不完整或网络连接被关闭）: {e}"))?;
        let frames = if let Some(chunk) = chunk.as_ref() { decoder.push(chunk)? } else { decoder.finish()? };
        for (event, data) in frames {
            let piece = crate::ai_stream::piece(protocol, &event, &data, !text.is_empty())?;
            if !piece.delta.is_empty() {
                if text.len() + piece.delta.len() > 4 * 1024 * 1024 { return Err("AI 生成内容过长，已停止接收".into()); }
                text.push_str(&piece.delta);
                on_delta(&piece.delta)?;
            }
            if piece.done { done = true; break; }
        }
        if done || chunk.is_none() { break; }
    }
    if !done { return Err("AI 流式响应提前结束，已保留收到的内容，请检查 SQL 是否完整".into()); }
    if text.trim().is_empty() { return Err("AI 没有返回内容".into()); }
    Ok(text)
}

struct Registration<'a> { state: &'a AppState, id: &'a str }
impl Drop for Registration<'_> {
    fn drop(&mut self) { self.state.ai_cancels.lock().unwrap().remove(self.id); }
}

pub fn cancel(state: &AppState, request_id: &str) -> bool {
    state.ai_cancels.lock().unwrap().get(request_id).is_some_and(|sender| sender.send(true).is_ok())
}

pub async fn generate(
    state: &AppState,
    input: AiGenerateInput,
    mut emit: impl FnMut(Value) -> Result<(), String>,
) -> Result<Value, String> {
    if input.request_id.is_empty() { return Err("缺少 AI 请求标识".into()); }
    let (sender, mut receiver) = tokio::sync::watch::channel(false);
    {
        let mut requests = state.ai_cancels.lock().unwrap();
        if requests.contains_key(&input.request_id) { return Err("AI 请求正在生成中".into()); }
        requests.insert(input.request_id.clone(), sender);
    }
    let _registration = Registration { state, id: &input.request_id };
    emit(json!({"kind":"started"}))?;
    tokio::select! {
        biased;
        _ = receiver.changed() => Err("AI 生成已停止".into()),
        result = tokio::time::timeout(std::time::Duration::from_secs(120), generate_inner(state, &input, &mut emit)) => {
            result.map_err(|_| "AI 生成超时，已停止接收".to_string())?
        }
    }
}

async fn generate_inner(
    state: &AppState,
    input: &AiGenerateInput,
    emit: &mut impl FnMut(Value) -> Result<(), String>,
) -> Result<Value, String> {
    let provider = state
        .ai_providers
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.id == input.provider_id)
        .cloned()
        .map(|mut provider| {
            normalize_protocol(&mut provider);
            provider
        })
        .ok_or_else(|| "请先配置一个 AI 服务商".to_string())?;
    let api_key = store::ai_secret(&provider.id)
        .ok_or_else(|| "这个服务商还没有配置 API Key".to_string())?;
    let tables = load_schema_tables(state, &input.session_id, &input.database).await?;
    let mut selected_names = ranked_table_names(&tables, &input.prompt, 12);
    let strong_match = selected_names.iter().any(|name| tables.iter().find(|table| &table.name == name)
        .is_some_and(|table| schema_score(table, &search_tokens(&input.prompt)) >= 14));
    // Ambiguous or unfamiliar business terms get a small catalog-only discovery call.
    // The full column definitions are sent only after the model names exact tables.
    if !strong_match || selected_names.len() < 2 {
        let planner_system = "You are Finch's database schema selector. Return only a JSON array of exact table names from the catalog. Select every table needed to answer the user's request, including order, shipment, logistics, bridge, and lookup tables. Never invent table names and never return SQL or explanations.";
        let planner_user = format!("{}\n\nUSER REQUEST:\n{}\n\nReturn at most 12 exact table names as JSON.", planner_catalog(&input.database, &tables), input.prompt.trim());
        if let Ok(planned) = request_text(&provider, planner_system, &planner_user, &api_key, |_| Ok(()),).await {
            selected_names.extend(planner_table_names(&planned, &tables));
        }
    }
    selected_names.sort();
    selected_names.dedup();
    if selected_names.is_empty() {
        selected_names = tables.iter().take(8).map(|table| table.name.clone()).collect();
    }
    let schema = selected_schema_context(&input.database, &tables, &selected_names);
    let system = format!(
        "You are Finch's MySQL SQL assistant. The selected table definitions below were retrieved from the live database after a schema discovery step. Generate ONE executable MySQL 8 statement from the user's natural language request.\n\
         Use ONLY the exact tables and columns shown. For Chinese concepts such as 订单、发货单、物流、出库单, use the selected definitions and join keys; do not claim a table is missing because its name is not literally Chinese. If the selected definitions are insufficient, return a short explanation and Finch will keep it as SQL comments.\n\
         Prefer SELECT; writes are allowed only if explicitly requested. Return only plain SQL text, without Markdown fences or explanations.\n\n         Live schema selection for database `{}`:\n{}",
        input.database, schema
    );
    let user = input.prompt.trim();
    if user.is_empty() {
        return Err("请输入你想完成的操作".into());
    }
    let text = request_text(&provider, &system, user, &api_key, |delta| emit(json!({"kind":"delta", "delta":delta}))).await?;
    let sql = sql_or_comment(&text);
    Ok(json!({
        "sql": sql,
        "raw": text,
        "provider": provider.name,
        "model": provider.model,
    }))
}


#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn strict_responses_gateway() -> (String, tokio::task::JoinHandle<()>, tokio::sync::oneshot::Sender<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (first_delta, first_seen) = tokio::sync::oneshot::channel();
        let mut first_seen = Some(first_seen);
        let server = tokio::spawn(async move {
            // Reject both historical formats, then require a real streaming request.
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (header_end, length) = loop {
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0, "incomplete request headers");
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&bytes[..end]).unwrap().to_lowercase();
                        assert!(headers.starts_with("post /v1/responses http/1.1"));
                        assert!(headers.contains("authorization: bearer test-only-key"));
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                        break (end + 4, length);
                    }
                    assert!(bytes.len() < 16_384);
                };
                while bytes.len() < header_end + length {
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0, "incomplete request body");
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let body: Value = serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                let (status, reply) = if !body["input"].is_array() {
                    ("400 Bad Request", json!({"error":{"message":"Input must be a list"}}))
                } else if body["stream"] != true {
                    ("400 Bad Request", json!({"error":{"message":"Stream must be set to true"}}))
                } else {
                    assert_eq!(body["instructions"], "Use the provided schema only.");
                    assert_eq!(body["input"][0]["role"], "user");
                    assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
                    assert_eq!(body["input"][0]["content"][0]["text"], "查询最近订单\n只返回 31 行");
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    let first = json!({"type":"response.output_text.delta", "delta":"```sql\nSELECT "});
                    stream.write_all(format!("data: {first}\n\n").as_bytes()).await.unwrap();
                    // Do not finish the response until the client has observed its first delta.
                    tokio::time::timeout(std::time::Duration::from_secs(2), first_seen.take().unwrap()).await.expect("client buffered the stream").unwrap();
                    let next = json!({"type":"response.output_text.delta", "delta":"31;\n```"});
                    stream.write_all(format!("data: {next}\n\ndata: {{\"type\":\"response.completed\",\"response\":{{}}}}\n\n").as_bytes()).await.unwrap();
                    continue;
                };
                let reply = reply.to_string();
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
            }
        });
        (base, server, first_delta)
    }

    #[tokio::test]
    async fn responses_list_input_works_with_strict_gateway() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let (base, server, first_delta) = strict_responses_gateway().await;
            let old_response = reqwest::Client::new().post(format!("{base}/responses"))
                .bearer_auth("test-only-key").json(&json!({"input":"old string format"})).send().await.unwrap();
            assert_eq!(old_response.status(), reqwest::StatusCode::BAD_REQUEST);
            assert_eq!(old_response.json::<Value>().await.unwrap()["error"]["message"], "Input must be a list");
            let old_stream = reqwest::Client::new().post(format!("{base}/responses"))
                .bearer_auth("test-only-key").json(&json!({"input":[]})).send().await.unwrap();
            assert_eq!(old_stream.status(), reqwest::StatusCode::BAD_REQUEST);
            assert_eq!(old_stream.json::<Value>().await.unwrap()["error"]["message"], "Stream must be set to true");
            let mut first_delta = Some(first_delta);
            let mut deltas = Vec::new();
            let provider = AiProvider { protocol:"responses".into(), base_url:base, model:"test-model".into(), ..Default::default() };
            let text = request_text(&provider, "Use the provided schema only.", "查询最近订单\n只返回 31 行", "test-only-key", |delta| {
                if let Some(sender) = first_delta.take() { let _ = sender.send(()); }
                deltas.push(delta.to_string());
                Ok(())
            }).await.unwrap();
            assert_eq!(strip_sql(&text), "SELECT 31;");
            assert_eq!(deltas.len(), 2, "must deliver multiple deltas before completion");
            server.await.unwrap();
        }).await.expect("local gateway test must finish promptly");
    }

    #[tokio::test]
    async fn streaming_failure_and_truncation_keep_delivered_deltas() {
        for tail in ["data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"upstream lost\"}}}\n\n", ""] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).await.unwrap();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {{\"type\":\"response.output_text.delta\",\"delta\":\"SELECT \"}}\n\n{tail}").as_bytes()).await.unwrap();
            });
            let provider = AiProvider { protocol:"responses".into(), base_url:base, model:"test".into(), ..Default::default() };
            let mut received = String::new();
            let error = request_text(&provider, "", "", "test-key", |delta| { received.push_str(delta); Ok(()) }).await.unwrap_err();
            assert_eq!(received, "SELECT ");
            assert!(error.contains("upstream lost") || error.contains("提前结束"), "{error}");
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_and_failed_requests_release_registration() {
        let state = AppState::new();
        state.ai_providers.lock().unwrap().clear();
        let input = || AiGenerateInput { request_id:"cancel-test".into(), provider_id:"missing".into(), session_id:"none".into(), database:String::new(), prompt:"SELECT".into() };
        let error = generate(&state, input(), |_| { assert!(cancel(&state, "cancel-test")); Ok(()) }).await.unwrap_err();
        assert!(error.contains("已停止"));
        assert!(state.ai_cancels.lock().unwrap().is_empty());
        assert!(generate(&state, input(), |_| Ok(())).await.is_err());
        assert!(state.ai_cancels.lock().unwrap().is_empty());
    }

    #[test]
    fn extracts_text_from_all_three_protocols() {
        let chat = json!({
            "choices": [{"message": {"role": "assistant", "content": "```sql\nSELECT 1\n```"}}]
        });
        assert!(text_from_chat(&chat).contains("SELECT 1"));

        let anthropic = json!({
            "content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "text", "text": "```sql\nSELECT 2\n```"}
            ]
        });
        assert_eq!(text_from_anthropic(&anthropic).trim(), "```sql\nSELECT 2\n```");

        let responses = json!({
            "object": "response",
            "output": [
                {"type": "reasoning", "summary": []},
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "```sql\nSELECT 3\n```", "annotations": []}
                ]}
            ]
        });
        assert!(text_from_responses(&responses).contains("SELECT 3"));

        let convenience = json!({"output_text": "SELECT 4"});
        assert_eq!(text_from_responses(&convenience), "SELECT 4");

        assert_eq!(extract_text("chat", &chat), text_from_chat(&chat));
        assert_eq!(extract_text("responses", &responses), text_from_responses(&responses));
    }

    #[test]
    fn non_sql_ai_text_is_safe_sql_comment() {
        assert_eq!(sql_or_comment("当前数据库没有可匹配的订单表。"), "-- 当前数据库没有可匹配的订单表。");
        assert_eq!(sql_or_comment("SELECT * FROM `订单`"), "SELECT * FROM `订单`");
        assert_eq!(sql_or_comment("```sql\nSELECT 1;\n```"), "SELECT 1;");
    }

    #[test]
    fn schema_context_prioritizes_relevant_tables_and_keeps_catalog() {
        let tables = vec![
            SchemaTable {
                name: "mc_order".into(), kind: "BASE TABLE".into(), comment: "订单主表".into(),
                columns: vec![SchemaColumn { name: "id".into(), column_type: "bigint".into(), key: "PRI".into(), comment: "订单ID".into() }],
            },
            SchemaTable {
                name: "audit_log".into(), kind: "BASE TABLE".into(), comment: String::new(),
                columns: (0..120).map(|i| SchemaColumn { name: format!("field_{i}"), column_type: "varchar(255)".into(), key: String::new(), comment: String::new() }).collect(),
            },
        ];
        let selected = ranked_table_names(&tables, "查询订单", 12);
        let context = selected_schema_context("mc", &tables, &selected);
        assert!(context.contains("`mc_order`"));
        assert!(context.contains("TABLE `mc_order`"));
        assert!(!context.contains("TABLE `audit_log`"));
        assert!(selected.contains(&"mc_order".to_string()));
    }

    #[test]
    fn planner_results_are_intersected_with_live_table_names() {
        let tables = vec![
            SchemaTable { name: "orders".into(), kind: "BASE TABLE".into(), comment: String::new(), columns: vec![] },
            SchemaTable { name: "shipments".into(), kind: "BASE TABLE".into(), comment: String::new(), columns: vec![] },
        ];
        let selected = planner_table_names(r#"["orders", "invented_table", "shipments"]"#, &tables);
        assert_eq!(selected, vec!["orders".to_string(), "shipments".to_string()]);
    }

    #[test]
    fn builds_requests_for_three_protocols() {
        let (url, body, headers) = build_request("chat", "https://api.test/v1", "m", "SYS", "USER", "KEY");
        assert_eq!(url, "https://api.test/v1/chat/completions");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["messages"][1]["content"], "USER");
        assert!(headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer KEY"));

        let (url, body, headers) = build_request("responses", "https://api.test/v1/", "m", "SYS", "USER", "KEY");
        assert_eq!(url, "https://api.test/v1/responses");
        assert_eq!(body["stream"], true);
        assert!(body.get("temperature").is_none());
        assert_eq!(body["instructions"], "SYS");
        assert_eq!(body["store"], false);
        assert_eq!(body["input"], json!([{
            "role": "user",
            "content": [{"type": "input_text", "text": "USER"}]
        }]));
        assert!(body.get("messages").is_none());
        assert!(headers.iter().any(|(k, _)| k == "Authorization"));

        let (url, body, headers) = build_request("anthropic", "https://api.test/v1", "m", "SYS", "USER", "KEY");
        assert_eq!(url, "https://api.test/v1/messages");
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "SYS");
        assert_eq!(body["messages"][0]["content"], "USER");
        assert!(body["max_tokens"].as_u64().unwrap() > 0);
        assert!(headers.iter().any(|(k, v)| k == "x-api-key" && v == "KEY"));
        assert!(headers.iter().any(|(k, v)| k == "anthropic-version" && !v.is_empty()));
    }

    #[test]
    fn normalizes_protocol_from_kind() {
        let mut legacy = AiProvider {
            kind: "anthropic".into(),
            protocol: String::new(),
            ..Default::default()
        };
        normalize_protocol(&mut legacy);
        assert_eq!(legacy.protocol, "anthropic");

        let mut openai = AiProvider {
            kind: "openai".into(),
            protocol: String::new(),
            ..Default::default()
        };
        normalize_protocol(&mut openai);
        assert_eq!(openai.protocol, "chat");

        let mut explicit = AiProvider {
            kind: "openai".into(),
            protocol: "responses".into(),
            ..Default::default()
        };
        normalize_protocol(&mut explicit);
        assert_eq!(explicit.protocol, "responses");
    }
}
