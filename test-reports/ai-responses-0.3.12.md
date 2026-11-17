# Responses 输入格式兼容修复（0.3.12）

日期：2026-11-16。范围：AI SQL 生成的 Responses 请求与响应解析。

## 原因与变更

原请求把用户文本直接放入 `input` 字符串。部分 Responses 兼容网关只接受消息列表，因此返回 `400 Bad Request: Input must be a list`。现在使用带 `input_text` 内容块的用户消息数组：

```json
{
  "instructions": "系统指令及数据库结构",
  "input": [
    {
      "role": "user",
      "content": [{"type": "input_text", "text": "用户需求"}]
    }
  ]
}
```

沿用现有配置、认证头、超时和输出解析。提取 HTTP 请求流程为内部 `request_text`，由正式生成入口和回归测试共用，避免测试绕过实际发送链路。

## 验证

| 场景 | 结果 |
| --- | --- |
| 本地严格 Responses 网关收到旧字符串格式 | 返回与用户报告一致的 400 和 `Input must be a list` |
| 正式请求函数发送新格式至同一网关 | HTTP 200；正确携带 `/v1/responses`、Bearer 认证、系统指令、中文及换行文本；解析并提取 `SELECT 31;` |
| Chat Completions / Responses / Anthropic 请求构造、文本提取和协议归一化 | 4 项 AI 专项测试全部通过，0 失败 |
| 客户端查询及连接切换回归 | 通过 |
| TypeScript、Vite 生产构建、Rust release 构建 | 通过 |

专项测试仅使用 `127.0.0.1` 动态端口及虚构 Key，没有读取用户的 API Key，也没有向真实 AI 服务发送数据库结构或产生调用费用。没有在用户实际服务商上验证。

原始结果见 `ai-responses-0.3.12-tests.log`、`ai-responses-0.3.12-client.log`。复跑：

```sh
FINCH_DATA_DIR=/tmp/finch-0312-tests cargo test --locked --manifest-path src-tauri/Cargo.toml --lib ai::tests -- --nocapture
npm run test:query-client
npm run app:build
```

使用 Node 20+。本次变更只涉及 AI 请求兼容，不重复运行需要 MySQL 的同步等集成测试。

交付安装包：`release/Finch-0.3.12-arm64.dmg`，应用：`release/Finch-0.3.12.app`。正式 identifier 为 `com.finch.sql`，原有服务商配置继续使用。
