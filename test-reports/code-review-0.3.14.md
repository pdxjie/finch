# Finch 0.3.14 — 代码梳理报告

日期：2026-11-17
范围：0.3.10 – 0.3.13 新增功能后的全量梳理

## 1. 梳理结论

架构分层清晰，新增功能（流式 AI、连接切换、只读校验、心跳、复合主键同步）都有对应后端模块与测试。本次主要做**减债**，未改变功能行为。

| 层 | 模块 | 状态 |
| --- | --- | --- |
| 前端 | `store.ts` / `components/*` / `lib/*` | 类型检查通过；无未使用导出（仅清理 `isDateType`） |
| 查询 | `query.rs` + `sql.rs` | 取消/超时/结果预算均有测试 |
| AI | `ai.rs` + `ai_stream.rs` | 三协议 + SSE + 严格网关回归 |
| 同步 | `sync.rs` | 数字主键分片、复合主键有界流式、只读目标拦截 |
| 连接 | `db.rs` + `heartbeat.rs` | 心跳、自动重连、Arc 身份校验 |
| 配置 | `store.rs` | Keychain + JSON，无明文密码 |

## 2. 本次修改

### Rust

- 删除未使用函数：`commands::session_or_err`、`db::{error_message, query_rows, json_to_mysql}`
- 删除过时字段 `Session.query_lock`（查询已改为独立取消通道）
- 修正未使用导入；`tunnel` 字段加注释说明其 RAII 作用
- `cargo check --all-targets`：**0 warning / 0 error**

### 前端

- 删除未使用导出 `format.isDateType`
- 清理 110 条已下线功能的 CSS：旧 AI 弹窗、旧筛选弹窗、rail、mock 预览等
- 样式表 185 KB → 172 KB（构建后 CSS 150 KB）
- **修复清理脚本误删 4 个 `@keyframes` 的右花括号**：`hero-rise`、`hero-visual-in`、`float-in`、`skeleton-pulse` 动画恢复
- 花括号平衡校验：1381 / 1381

### 文档与脚本

- 新增 `docs/CODE_MAP.md`（分层、数据流、状态模型、扩展步骤、技术债）
- README 更新实际能力、目录结构、测试命令、截图（移除过时的 AI 弹窗图）
- `docs/ANALYSIS.md` 更新 schema discovery、流式 AI、连接安全、验证矩阵
- `package.json` 新增 `npm run verify` 与 `npm run test:rust`
- 版本 0.3.13 → 0.3.14（三处 manifest 同步）

## 3. 验证

```
npm run verify
  ├─ tsc --noEmit                                  PASS
  ├─ node scripts/test-ai-stream.cjs               PASS
  ├─ node scripts/test-query-client.cjs            PASS
  └─ cargo test (src-tauri)                        29 passed / 0 failed
```

- `cargo check --all-targets`：0 warning
- `vite build`：通过，CSS 150 KB / JS 1.26 MB
- `hdiutil verify`：VALID
- 前端内嵌 hash：`index-BZP1XxM4.js` 与 `dist` 一致；产物不含调试探针
- DMG：7.44 MB；App：20.20 MB
- SHA256：`0ae125641b29455855843c967c47bb380e64c608d5af30afa3bbb155a1e30082`

## 4. 仍然存在的技术债

1. `styles.css` 仍约 172 KB，建议按 grid/editor/sidebar/modals 拆分。
2. `store.ts` 约 1,500 行，后续按 connection/query/ai 拆 slice。
3. AI schema discovery 依赖 token 排序启发式，超大库可考虑全文索引或向量检索。
4. 表设计器不支持外键管理；已有索引改名需删除重建。
5. 转储不含视图/存储过程/事件。
