# Finch 产品与技术方案（Tauri 2）

> 一款为 macOS 重新设计的 MySQL 工作台：**Tauri 2 + Rust + React**，安装包约 7 MB，界面尽量轻，查询和同步优先保证不卡死。

---

## 1. 为什么又做一个 MySQL 客户端

现有工具的痛点非常集中：

| 痛点 | 真实原因 | Finch 的应对 |
| --- | --- | --- |
| 卡 | 一次性把大结果集拉进前端、全量 DOM 渲染、每次操作重扫元数据 | Rust 后端流式读取 + 自动结果上限 + 虚拟化网格 + 服务端分页 |
| 用一会儿就断 | MySQL `wait_timeout`、云代理空闲回收、NAT、合盖休眠；客户端没有心跳和重连 | 连接池 Keep-alive、健康检查、断线自动重连、只读查询安全重试 |
| 重 | Electron/Java 运行时；安装包数百 MB，内存数百 MB | Tauri + 系统 WKWebView，Rust 后端；当前 release `.app` 约 **19 MB**，DMG 约 **7 MB** |
| AI 不可用 | AI 客户端不知道真实表结构，容易编表名/列名 | 生成 SQL 时读取当前数据库真实 schema，并要求模型只使用这些字段 |
| 同步危险 | 同步工具默认 ALTER 目标表，开发库结构被悄悄改掉 | 目标只允许本地/开发；已存在目标表**只写数据，不改 DDL**；缺表才 CREATE |
| DDL 门槛 | 建表/改表必须手写 SQL | 表设计器 + 结构化 DDL，参数校验和二次确认 |
| 转储崩溃 | 大表一次性读进内存 | Rust 流式读行、批量写 SQL 文件 |

Navicat 功能全但订阅贵、重、空闲断连；DBeaver 依赖 Java；TablePlus 快但功能有边界；DataGrip 强但偏 IDE。Finch 聚焦 **连接 → 查表/写 SQL → 看/改数据 → 安全同步** 这条高频路径。

---

## 2. 产品原则

1. **不卡死优先**：所有可能无限增长的数据流必须有上限、分页、流式或取消机制。
2. **本地优先**：无账号、无云端、无遥测；密码和 AI Key 进 macOS Keychain。
3. **默认安全**：生产连接只读默认可用；同步目标只能本地/开发；危险 DDL 二次确认。
4. **键盘优先**：⌘K、⌘↵、⌘T、⌘W、⌘E。
5. **界面克制**：一个侧栏、一个工作区，减少重复状态栏和低频信息。

---

## 3. 架构

```
┌──────────────────────────────────────────────────────────────┐
│ React 19 + TypeScript + CodeMirror 6 + 虚拟网格              │
│ 侧栏 / 查询 / 结果 / 同步 / AI / 表设计器 / 转储              │
└───────────────────────────┬──────────────────────────────────┘
                            │ @tauri-apps/api invoke / event
┌───────────────────────────▼──────────────────────────────────┐
│ Tauri 2 IPC（Rust）                                          │
│ commands.rs: 连接/查询/schema/AI/同步/DDL/转储/文件          │
│ db.rs: mysql_async Pool / 会话 / 行序列化 / Keychain 配置    │
│ query.rs: 流式结果、LIMIT 保护、KILL QUERY、历史             │
│ schema.rs: information_schema、表数据、服务器指标            │
│ sync.rs: 目标 guard、缺失表 CREATE、批量 UPSERT              │
│ ddl.rs: CREATE/ALTER/DROP TABLE                              │
│ dump.rs: 流式 SQL 转储                                       │
│ ai.rs: OpenAI 兼容 / Anthropic 请求、schema context          │
└───────────────────────────┬──────────────────────────────────┘
                            │ MySQL protocol / TLS
                         MySQL 8.x
```

Tauri 只使用系统 WKWebView，不打包 Chromium；前端仍是熟悉的 React，数据库和文件操作全部在 Rust 侧。

---

## 4. 性能设计

### 4.1 查询

- Rust `mysql_async::QueryResult` **逐行读取**，最多 5,000 行。
- 对没有 `LIMIT` 的 SELECT 自动追加 `LIMIT maxRows + 1`。
- 达到上限立即停止读取并断开该池连接，避免留下 pending result 污染下一次查询。
- 结果体积预算 6 MB：逐行累计原始字节数，超限立即停止读取；宽表 / 大 TEXT 不会把 GB 级数据送进 IPC。
- 只有语句末尾的 `LIMIT` 才视为已限流；子查询里的 LIMIT 不会关闭外层保护。
- 取消走独立控制连接（`Conn::new(opts)`）执行 `KILL QUERY`，不占连接池，也不受长查询持锁影响。
- 读取循环按行检查取消标记，取消后不再消费剩余结果集。
- 服务端超时：`SET SESSION max_execution_time`，默认 60 秒，可关闭；错误 3024 映射为中文提示。
- 用户可配置最大行数；硬上限 50,000。
- 取消：保存 MySQL `threadId`，通过新的连接执行 `KILL QUERY`。
- 查询失败如果是连接错误，且第一条是只读语句，会重连并重试一次；写语句绝不自动重试。

### 4.2 表数据

- 服务端 `LIMIT / OFFSET`，默认 200 行，单页最大 2,000。
- 搜索、筛选在 SQL 侧完成；COUNT 单独查询并带 8 秒超时，超时显示未知总数。
- 筛选面板内联展开，支持中文运算符、多条件、BETWEEN、NULL / 空值和列表值；不再弹窗。
- 前端 `@tanstack/react-virtual` 只渲染视口行。
- 结果列可单独隐藏 / 显示；文本单元格在底部抽屉中完整查看，JSON 自动格式化。
- 打开表分两步：数据页先返回并渲染，`COUNT(*)` 单独请求、6 秒超时，慢表不再阻塞首屏。
- SQL 补全按上下文排序（表 / 字段 / 关键字 / 片段），每个候选项带中文说明；`Tab` 在补全打开时只接受、不缩进。
- 点击侧栏数据库打开表浏览页：卡片网格按容器宽度自适应（一行 2–6 张表），表名/注释实时筛选、按名称/行数/大小排序、表与视图切换；按行虚拟化，上千张表也不卡。
- 单击卡片从右侧滑出明细栏（字段/索引/外键/触发器/统计/DDL），双击进入数据页；浏览状态存在标签页上，返回时筛选不丢。
- DDL 使用只读 CodeMirror 展示（行号 + MySQL 高亮），并以专用格式化器保证「一条定义一行」、关闭折行、横向滚动，不再出现定义被拆行。
- 卡片操作走「⋯」按钮或右键，菜单 portal 到 body、按光标定位并在边缘翻转，避免被滚动容器裁剪。
- 所有 title / data-tooltip 统一由全局即时 tooltip 接管，悬停约 0.1 秒出现并跟随鼠标。
- 按钮统一为三档高度（28 / 26 / 34）与两级圆角（7 / 6），ghost 无边框、主按钮纯色 + 轻投影，所有按钮带 focus-visible 焦点环。
- 所有原生 `<select>` 替换为自绘 `Select`（portal 浮层、键盘导航、视口翻转），避免 macOS 原生弹层不可样式化。
- SQL 补全的 info 面板给出中文用途 + 示例 SQL；列表行内直接显示函数签名或字段类型。
- 数字、日期、NULL、BLOB 在 Rust 侧转换为结构化 JSON；BLOB 仅传预览和大小。

### 4.3 同步

- 源表使用 `query_iter` 流式读取，不在内存里存全表。
- 目标批量 `INSERT ... ON DUPLICATE KEY UPDATE`，默认 2,000 行/批，可选 500 – 10,000；按列数自动降低批大小。
- 数字主键大表（≥ 5,000 行）按主键范围切成 4–8 个分片，每个分片用 **keyset 游标** `pk > last ORDER BY pk LIMIT` 翻页，不使用 OFFSET。
- 多表 / 多分片通过 `buffer_unordered` 并发写入，默认 4，最高 8；同源同目标连接自动限为 4，避免一个 8 连接池被 16 个 worker 互锁。
- 每个工作连接单独关闭 `foreign_key_checks` / `unique_checks`，完成或出错后恢复。
- 缺表时复制源表 DDL，只执行 `CREATE TABLE IF NOT EXISTS`；已有表不改结构。
- 只同步两边同名字段；目标多出来的列保留，源独有列跳过并报告。

### 4.4 转储

- 逐表 `SHOW CREATE TABLE` + 逐行读取数据，`BufWriter` 写文件。
- 批量 100 行生成一条 INSERT，避免一行一条语句。
- 支持结构/数据独立开关，大表不会整体进内存。

---

## 5. AI 自然语言 SQL

### 服务商

支持三种线路协议，与厂商解耦：

- **Chat Completions**：`POST {base}/chat/completions`，`messages[]` 结构；覆盖 OpenAI、DeepSeek、Moonshot 及各类兼容网关
- **Responses API**：`POST {base}/responses`，`instructions` + `input`；解析 `output[].content[].output_text`，兼容 `output_text`
- **Anthropic Messages**：`POST {base}/messages`，`system` + `messages[]`，`x-api-key` + `anthropic-version` 头

同一厂商可以并存多条线路（例如 OpenAI Chat 与 OpenAI Responses）。旧配置没有协议字段时，`anthropic` 回落到 Messages，其余回落到 Chat Completions。

每个服务商独立保存 Base URL、模型、API Key。API Key 只写 macOS Keychain；`ai_providers.json` 不含密钥。

### Schema discovery（按需，不再一次性塞全库）

1. 先查轻量表目录（表名、注释、行数）；
2. 用 prompt token 与表名/注释做排序，取前 N 张候选表；
3. 只展开候选表的字段（类型、主键、默认值、注释），拼进 system prompt；
4. 模型如果提到目录里存在、但未展开的表名，再补查这些表的字段重试一次；
5. 新表会自动进入目录，不需要手动维护。

Prompt 约束：

- 只能使用给出的表和字段；
- 不存在结构要明确说明，不能编；
- 默认一条 MySQL 8 语句；
- 返回 SQL 代码块（前端会去掉围栏）。

### 流式生成

- 三种协议统一 `stream: true`，Rust `ai_stream::Decoder` 增量解析 SSE（跨网络块 UTF-8、CRLF、多行 `data`、`[DONE]`）。
- 通过 Tauri **Channel** 把 `delta` 推给前端；store 用 32ms 节流写入 CodeMirror，保留已有 SQL 并追加。
- 只把 SQL 写进编辑器，不自动执行；解释性文字自动转成 `--` 注释。
- 关闭标签页/点停止会取消请求；`requestId` 隔离，过期事件不会写入新标签。
- 失败/截断保留已收到的内容，并提示错误。

### 连接安全与生命周期

- 只读连接在 Rust 侧统一校验：拒绝 CTE 写语句、可执行注释 `/*!`、`INTO OUTFILE`、`SET`/`CALL`/锁函数等；保存只读配置后立即生效。
- 每个连接按自己的 `keep_alive_seconds` 心跳；池繁忙时不会误判断线并替换健康连接。
- 手动断开后，旧会话的心跳/重连结果通过 `Arc::ptr_eq` 丢弃，不会把连接重新拉起来。
- 自动重连关闭时，ping 失败只标记 error，不重建连接。

---

## 6. 数据同步的安全边界

同步是风险最高的功能，因此边界写死在 Rust 后端，不只依赖 UI：

1. `target.category` 必须是 `local` 或 `dev`；`staging` / `prod` 直接拒绝。
2. 目标连接不能是只读模式。
3. 源和目标不能是同一个数据库。
4. 目标已有表：
   - 不执行 ALTER；
   - 只写入共同字段；
   - 目标额外字段保留。
5. 目标缺表：
   - 读取源 `SHOW CREATE TABLE`；
   - 执行 `CREATE TABLE IF NOT EXISTS`；
   - 源表 DDL 的索引/字符集/引擎随之创建；
   - 外键检查临时关闭，以允许创建顺序不确定的表。
6. 写入模式：
   - UPSERT：有主键时按主键更新；
   - 追加：适合日志/无主键表；
   - 清空后写入：只清空数据，不改 DDL。
7. 每张表独立报告 `read / written / created / skippedColumns / error`。

---

## 7. 表设计与转储

### 表设计器

- 创建：字段名、类型、NULL、默认值、自增、主键、注释、引擎、字符集、索引。
- 索引：普通 / 唯一 / 全文 / 空间，多字段联合索引（按勾选顺序），索引名留空自动生成；改表时索引变更走 DROP + ADD。
- 编辑：添加字段、修改类型/默认值/注释/NULL、删除字段、重命名表。
- 删除表：二次确认。
- 后端校验标识符和类型，禁止分号、注释、`DROP/ALTER` 等注入片段。
- 已有字段重命名暂不支持（避免 `MODIFY`/`DROP` 错配），请用 SQL 编辑器。

### 转储

- 结构：`DROP TABLE IF EXISTS` + `SHOW CREATE TABLE`。
- 数据：流式生成 INSERT。
- 文件头包含 `USE database; SET NAMES utf8mb4; SET FOREIGN_KEY_CHECKS=0;`。
- 支持选择表，避免全库误操作。

---

## 8. 连接与凭据

- 环境分类：`local` / `dev` / `staging` / `prod`，侧栏按分类分组。
- 连接池：`mysql_async::Pool`，`min=1`、`max=8`、空闲 90s。
- TCP keep-alive 30s；会话健康检查每 30s。
- SSH：`/usr/bin/ssh -N -L` 私钥隧道；已支持私钥，密码认证待实现。
- TLS：`required` / `verify`，支持 CA 文件。
- 密码、SSH passphrase、AI Key：macOS Keychain（`security` CLI）。
- 只读连接在 Rust 侧阻止写语句。

---

## 9. 验证

### Rust 集成测试

在隔离 MySQL 8.0.42 上执行：

- SELECT / 数值、日期序列化；
- SQL 字节级扫描：引号内分号、注释、DELIMITER、中文 CASE 不 panic；
- 只读校验：CTE 写语句、可执行注释、OUTFILE、锁函数；
- 查询：100k 行 8 JOIN 中文 CASE 返回 31 行；超时、取消、异常恢复；
- AI：SSE 跨块 UTF-8、三种协议增量、严格网关回归、取消释放；
- 中文筛选运算符（包含、BETWEEN）；
- 数据同步：目标缺失表创建、220 行写入、二次同步 Upsert、目标已有 DDL 不变、目标独有列保留；
- 6,000 行数字主键表自动分成多个分片，keyset 游标 + 4 并发同步后行数一致；
- 建表 / 改表 / 删表；
- 索引：建表自动命名索引、新增唯一索引、修改/删除索引、引用不存在字段被拒绝；
- 流式转储包含 CREATE 与 INSERT；
- 测试结束后清理目标数据库。

```bash
cd src-tauri && cargo test -- --nocapture
```

### 已完成的手工验证

- Tauri release 应用实际连上 demo MySQL；
- 表数据加载、分页、虚拟网格；
- 内联筛选面板、中文运算符、文本查看、列显隐；
- 查询编辑器执行聚合 SQL，返回 7 行结果；
- 同步向导读取真实表列表并显示「将创建表」；
- 内联 AI 输入条（⌘P）流式写入编辑器；
- 表设计器、转储弹窗的 Tauri 窗口展示；
- release `.app` 约 19.5 MB，DMG 约 7.2 MB。

### 当前未覆盖

- AI 真实公网服务商调用需要用户自己的 API Key（本地严格网关已做 HTTP 回归，未用付费 Key 打公网）；
- SSH 密码认证、二级索引设计、存储过程转储；
- Windows/Linux 打包；
- Apple Developer 签名 / notarization。

---

## 10. 路线图

**v0.3.15**
- 样式表按功能拆分，`store.ts` 按领域拆 slice
- SSH 密码认证
- AI 结果 diff / 二次编辑
- 表设计器外键管理

**v0.4**
- 事务面板（显式 BEGIN/COMMIT/ROLLBACK）
- 视图/存储过程转储
- 同步断点续传与取消
- 表/列 autocomplete 的全库索引缓存

**长期**
- Tauri 插件化
- 可选的本地模型（Ollama / LM Studio）
- Windows/Linux

---

## 11. 成功标准

- 冷启动 < 1.5s（Apple Silicon）；
- release 包 < 25MB；
- 打开 1,000 万行表不把数据全部拉进前端；
- 空闲 30 分钟后查询无需手动重连；
- 同步 10 万行不造成 UI 卡死；
- AI 生成的 SQL 表名/列名默认与真实 schema 匹配；
- 目标 DDL 在同步过程中零 ALTER。
