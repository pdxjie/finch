# Finch 代码地图

> 版本：0.3.14 · 技术栈：Tauri 2 + Rust + React 19 + TypeScript + CodeMirror 6
> 适用：接手、排查、扩展功能前的快速定位。配套阅读 [ANALYSIS.md](ANALYSIS.md)（设计取舍）与 [README](../README.md)（用户功能）。

---

## 1. 进程与分层

```
┌────────────────────────────────────────────────────────────────────┐
│ WebView（React）                                                   │
│  App ─┬─ Titlebar / Sidebar / TabBar                              │
│       ├─ QueryWorkspace ─ SqlEditor + ResultGrid + AIComposer      │
│       ├─ TableWorkspace ─ 数据网格 / 结构 / 内联筛选 / 文本抽屉     │
│       ├─ DatabaseWorkspace（表卡片浏览）                            │
│       ├─ SyncModal / TableDesignerModal / DumpModal                │
│       └─ SettingsModal（含 AIProvidersPanel）                      │
│  store.ts（Zustand，唯一可变状态）                                 │
└───────────────────────────┬────────────────────────────────────────┘
                            │ @tauri-apps/api invoke / Channel / event
┌───────────────────────────▼────────────────────────────────────────┐
│ Rust（src-tauri/src）                                              │
│  commands.rs  Tauri 命令入口（参数校验 + 调度）                     │
│  db.rs        连接池 / 会话 / 值序列化 / Keychain 配置              │
│  query.rs     查询执行、超时、取消、结果预算、历史                  │
│  sql.rs       SQL 扫描：拆分、首关键字、只读判定（唯一实现）        │
│  schema.rs    元数据、表数据、COUNT、服务器指标                     │
│  ai.rs        AI 协议、流式请求、schema discovery                   │
│  ai_stream.rs SSE 解码与协议增量解析                                │
│  sync.rs      数据同步（目标 guard / 分片 / 并发）                  │
│  ddl.rs       建表 / 改表 / 删表 / 索引                            │
│  dump.rs      流式 SQL 转储                                        │
│  heartbeat.rs 连接心跳与自动重连决策
  lan.rs        局域网发现、TLS 会话、文件/表传输                                │
│  store.rs     JSON 配置 + macOS Keychain                           │
│  ssh.rs       SSH 隧道（私钥）                                     │
└────────────────────────────────────────────────────────────────────┘
```

**约定**：前端不直接拼 SQL 执行；所有危险操作（写、DDL、同步、KILL）都在 Rust 侧做二次校验。

---

## 2. 关键数据流

### 2.1 执行查询

```
SqlEditor → store.runQuery(tabId)
  → api.query.execute({sessionId, sql, database, executionId, maxRows, autoLimit, timeoutMs})
  → commands::execute_query → query::execute
       split_statements(sql)                     // sql.rs
       validate_read_only（只读连接时）            // sql.rs
       pool.get_conn + USE db
       SET SESSION max_execution_time
       每条语句：apply_result_limit → query_iter → 逐行读取
         · 每行检查 cancel 标记
         · 行数上限（默认 5000）
         · 字节预算（6 MB，超限断开连接）
  ← QueryResult { statements[], duration_ms, cancelled }
store 更新 tab.result / lastRunMs；QueryWorkspace 渲染 ResultGrid
```

取消：`store.cancelQuery → query::cancel`，用**独立连接** `KILL QUERY`，并在读取循环里检查 flag。

### 2.2 AI 流式生成

```
AIComposer（⌘P）→ store.generateAiSql(tabId, prompt, providerId)
  → api.ai.generate(input, onEvent)  // invoke + Tauri Channel
  → commands::generate_sql → ai::generate(..., |event| channel.send)
       load_schema_tables（轻量目录） → ranked_table_names → 候选表字段
       build_request(protocol) → reqwest POST stream:true
       ai_stream::Decoder 解析 SSE → piece() 提取 delta/done
  ← Channel: started / delta / done
store 用 streamedSql() 去掉 Markdown 围栏，32ms 节流写入编辑器
```

- 流式任务以 `requestId` 隔离；关闭标签页会 `cancel`。
- 后端 `ai_cancels` 保存取消标记，请求注册/释放有 RAII 保护。
- 只有 SQL 文本进入编辑器；解释性文字自动变成 `--` 注释。

### 2.3 表数据

```
openTable → store.loadTable
  → api.data.table(...)     // 先返回行，total = null
  → api.data.count(...)     // 并行 COUNT(*)，6s 超时；回来再补 total
```

`TableWorkspace` 持有筛选草稿、选中单元格、文本抽屉；`ResultGrid` 负责虚拟化、列显隐、复制/编辑菜单。

`DatabaseWorkspace` 的表浏览状态（筛选、排序、表/视图、选中表、批量勾选）保存在 `WorkspaceTab.db*` 字段上，切换标签页不丢失；单击卡片 160ms 后打开右侧明细栏（`TableDetailPanel`，按需拉取 `tableDetails`），双击直接 `openTable`。

DDL 统一用 `DdlViewer`（只读但可选中复制的 CodeMirror + `lib/sqlHighlight` 高亮）渲染；默认由 `lib/ddlFormat.ts` 按「一条定义一行」重整，关闭自动折行、横向滚动，可切原始文本；表详情与表结构面板复用同一组件。

### 2.3.1 转储

```
DumpModal → api.dump({path, structure, data, tables, splitFiles})
  → dump::dump
     splitFiles=false: 一个 BufWriter<File>，逐表写 structure/data
     splitFiles=true : create_dir_all(path) + 每表 <safe-name>.sql 独立 BufWriter
  返回 { path, tables, files[], split }
```

前端可先「预览所选 DDL」，通过 `schema.tableDetails` 逐表取 `SHOW CREATE TABLE` 并用 `formatCreateTable` 展示。

### 2.4 数据同步

```
SyncModal → api.sync.preview（列表 + exists）
         → api.sync.run(SyncRequest)
  → sync::run
     目标必须是 local/dev；同库拒绝
     bootstrap 连接：USE target；建缺失表（CREATE TABLE IF NOT EXISTS）
     逐表：列交集、目标 PK、replace 时 TRUNCATE、单数字主键分片
     并发 job（buffer_unordered）：keyset 游标 / 有界流式读取
       每批 INSERT / ON DUPLICATE KEY UPDATE
     事件 sync:progress / sync:table
```

### 2.5 连接生命周期

```
connections.json + Keychain 密码
  → commands::connect → db::open_session（SSH 隧道 / TLS / 池）
  → AppState.sessions: HashMap<String, Arc<Session>>
  → lib.rs 心跳循环：heartbeat::claim_due → ping_session
      失败且自动重连开启 → reconnect_state（替换 Arc<Session>）
```

手动断开（连接行电源按钮 / 右键 / 命令面板）会移除 `AppState.sessions` 中的 `Arc<Session>`：连接池 `disconnect`、SSH 隧道随 `Session` 析构关闭，心跳循环不再遍历该会话。

重连/心跳结果回写前会比较 `Arc::ptr_eq`，旧会话的结果不会覆盖新状态。

---

## 3. 前端状态模型（store.ts）

| 字段 | 键 / 说明 |
| --- | --- |
| `connections` | 连接配置（密码不在内） |
| `sessions` | `id → SessionInfo`（状态、延迟、版本） |
| `databases` | `sessionId → DatabaseInfo[]` |
| `tables` / `views` | `` `${sessionId}::${database}` → TableInfo[] `` |
| `columns` | 同键 → `{ table → ColumnInfo[] }`，供 SQL 补全 |
| `routines` | 同键 → 存储过程/函数 |
| `tabs` | 工作区标签（query / table / database / dashboard） |
| `settings` | 服务端持久化，启动合并默认值；`lib/visual.ts` 把字体/主题色/动画写入 CSS 变量，并通过 `set_webview_zoom` 应用缩放 |
| `aiOpen` | 全局 AI 输入条开关（⌘P） |

约束：

- 所有异步加载都用序号 / requestId 防止过期响应写回（`tableLoads`、`aiFlushes`）。
- 查询页切换连接会清空旧结果，执行或生成期间禁止切换。
- 只读判断以后端为准，前端只做提示。

---

## 4. SQL 扫描（sql.rs）

- **按字节扫描**，不在字符边界切 UTF-8；中文、CASE、注释安全。
- `split_statements`：支持 `--`、`#`、`/* */`、引号内分号、`DELIMITER`。
- `validate_read_only`：拒绝可执行注释 `/*!`、CTE 写语句、`INTO OUTFILE`、锁函数等。
- `first_keyword`：跳过 BOM/空白/普通注释。
- **db.rs 通过 `pub use` 复用**，不要在前端或别处再造一套拆分逻辑。

---

## 5. 测试与验证

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| Rust 单元 + 集成 | `cargo test --manifest-path src-tauri/Cargo.toml` | SQL 扫描、查询/取消/超时、结果预算、AI 协议与流解析、只读、同步、DDL、心跳 |
| 前端 IPC/store | `npm run test:query-client` | 查询 IPC、看门狗、取消、连接切换、失败回滚 |
| AI 流式 store | `npm run test:ai-stream` | 增量写入、围栏、停止、早期取消、标签隔离 |
| 类型 | `npm run typecheck` | 全量 TS |
| 打包 | `npm run package:mac` | `.app` + `.dmg` |

一键：

```bash
npm run verify
```

MySQL 集成测试默认在 `127.0.0.1:3407`（`scripts/start-demo-db.sh`）；没有数据库时自动 skip。CI 可设 `FINCH_REQUIRE_MYSQL_TESTS=1` 强制失败。

`test-reports/` 保存每个版本的测试与打包证据（Markdown + 日志）。

---

## 6. 扩展指南

新增一个后端能力：

1. `models.rs` 定义请求/响应（`serde(rename_all="camelCase")`）。
2. 在 `schema.rs` / `query.rs` / 新模块实现，返回 `Result<_, String>`。
3. `commands.rs` 写 `#[tauri::command]`，`lib.rs` 的 `invoke_handler` 注册。
4. `types.ts` + `lib/tauriApi.ts` 增加类型和方法。
5. `store.ts` 调 API 并维护缓存；组件只读 store。
6. 补 Rust 测试 +（必要时）`scripts/test-*.cjs`。

UI 规范：

- 按钮用 `.btn` 体系，下拉用 `Select`，提示用 `title`（全局即时 tooltip），右键菜单用 `ContextMenu`。
- 表格类数据用 `ResultGrid` 或虚拟化列表，不要直接渲染大数组。

---

## 7. 已知技术债

1. `styles.css` 约 170 KB，历史叠加较多；虽已清理死规则，仍建议按 feature 拆分（grid / editor / sidebar / modals）。
2. `store.ts` 约 1,500 行，承担了较多领域逻辑；后续可按 query/connection/ai 拆 slice。
3. AI schema discovery 是启发式排序（表名/注释/列名 token 匹配），超大库可能需要更强的检索。
4. 表设计器暂不支持外键管理与已有索引改名（改名 = 删除 + 重建）。
5. 转储不含视图/存储过程/事件。
