//! Incremental SSE decoding, including UTF-8 split across transport chunks.
use serde_json::Value;

const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
    data: Vec<String>,
    event: String,
    frame_bytes: usize,
}

impl Decoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<(String, String)>, String> {
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut consumed = 0;
        while let Some(length) = self.pending[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + length;
            let line = std::str::from_utf8(&self.pending[consumed..end])
                .map_err(|_| "AI 流式响应不是有效的 UTF-8".to_string())?.trim_end_matches('\r').to_string();
            self.line(&line, &mut frames)?;
            consumed = end + 1;
        }
        self.pending.drain(..consumed);
        if self.pending.len() + self.frame_bytes > MAX_FRAME_BYTES {
            return Err("AI 单条流式消息过大".into());
        }
        Ok(frames)
    }

    fn line(&mut self, line: &str, frames: &mut Vec<(String, String)>) -> Result<(), String> {
        let line = line.trim_start_matches('\u{feff}');
        if line.is_empty() {
            if !self.data.is_empty() {
                frames.push((std::mem::take(&mut self.event), self.data.join("\n")));
            }
            self.data.clear();
            self.event.clear();
            self.frame_bytes = 0;
        } else if let Some(value) = line.strip_prefix("data:") {
            self.frame_bytes += value.len();
            if self.frame_bytes > MAX_FRAME_BYTES { return Err("AI 单条流式消息过大".into()); }
            self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        } else if let Some(value) = line.strip_prefix("event:") {
            self.event = value.trim().to_string();
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<Vec<(String, String)>, String> {
        let mut frames = Vec::new();
        if !self.pending.is_empty() {
            let line = String::from_utf8(std::mem::take(&mut self.pending))
                .map_err(|_| "AI 流式响应提前结束（UTF-8 不完整）".to_string())?;
            self.line(line.trim_end_matches('\r'), &mut frames)?;
        }
        self.line("", &mut frames)?;
        Ok(frames)
    }
}

pub struct Piece {
    pub delta: String,
    pub done: bool,
}

pub fn piece(protocol: &str, event: &str, data: &str, has_text: bool) -> Result<Piece, String> {
    if data.trim() == "[DONE]" { return Ok(Piece { delta: String::new(), done: true }); }
    let payload: Value = serde_json::from_str(data).map_err(|e| format!("AI 流式消息解析失败: {e}"))?;
    let kind = payload["type"].as_str().unwrap_or(event);
    if kind == "error" || payload.get("error").is_some_and(|error| !error.is_null())
        || matches!(kind, "response.failed" | "response.incomplete")
    {
        let message = payload["error"]["message"].as_str()
            .or_else(|| payload["response"]["error"]["message"].as_str())
            .or_else(|| payload["response"]["incomplete_details"]["reason"].as_str())
            .or_else(|| payload["message"].as_str()).unwrap_or("生成中断或响应不完整");
        return Err(format!("AI 流式生成失败: {message}"));
    }
    let mut result = Piece { delta: String::new(), done: false };
    match protocol {
        "responses" => match kind {
            "response.output_text.delta" => result.delta = payload["delta"].as_str().unwrap_or("").into(),
            "response.output_text.done" if !has_text => result.delta = payload["text"].as_str().unwrap_or("").into(),
            "response.completed" => {
                result.done = true;
                if !has_text { result.delta = crate::ai::text_from_responses(&payload["response"]); }
            }
            _ => {}
        },
        "anthropic" => match kind {
            "content_block_start" if payload["content_block"]["type"] == "text" => {
                result.delta = payload["content_block"]["text"].as_str().unwrap_or("").into();
            }
            "content_block_delta" if payload["delta"]["type"] == "text_delta" => {
                result.delta = payload["delta"]["text"].as_str().unwrap_or("").into();
            }
            "message_delta" if payload["delta"]["stop_reason"] == "max_tokens" => return Err("AI 输出达到长度上限，SQL 可能不完整".into()),
            "message_stop" => result.done = true,
            _ => {}
        },
        _ => {
            if let Some(choice) = payload["choices"].get(0) {
                result.delta = choice["delta"]["content"].as_str().unwrap_or("").into();
                match choice["finish_reason"].as_str() {
                    Some("length" | "content_filter") => return Err("AI 输出被截断，SQL 可能不完整".into()),
                    Some(_) => result.done = true,
                    None => {}
                }
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_crlf_comments_and_multiline_data_byte_by_byte() {
        let input = ": heartbeat\r\nevent: test\r\ndata: {\"text\":\"中文\",\r\ndata: \"n\":1}\r\n\r\ndata: [DONE]";
        let mut decoder = Decoder::default();
        let mut frames = Vec::new();
        for byte in input.as_bytes() { frames.extend(decoder.push(&[*byte]).unwrap()); }
        frames.extend(decoder.finish().unwrap());
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].0, "test");
        assert_eq!(serde_json::from_str::<Value>(&frames[0].1).unwrap()["text"], "中文");
        assert_eq!(frames[1].1, "[DONE]");
    }

    #[test]
    fn handles_protocol_deltas_completion_and_errors() {
        assert_eq!(piece("responses", "", r#"{"type":"response.output_text.delta","delta":"SELECT "}"#, false).unwrap().delta, "SELECT ");
        assert!(piece("responses", "", r#"{"type":"response.completed","response":{}}"#, true).unwrap().done);
        assert_eq!(piece("anthropic", "", r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"1"}}"#, false).unwrap().delta, "1");
        assert!(piece("anthropic", "message_stop", "{}", true).unwrap().done);
        assert_eq!(piece("chat", "", r#"{"choices":[{"delta":{"content":"SELECT"}}]}"#, false).unwrap().delta, "SELECT");
        assert!(piece("chat", "", "[DONE]", true).unwrap().done);
        assert!(piece("responses", "", r#"{"type":"response.failed","response":{"error":{"message":"bad model"}}}"#, true).err().unwrap().contains("bad model"));
        assert!(piece("chat", "", r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#, true).is_err());
    }
}
