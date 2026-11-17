# 连接切换与数据安全回归（0.3.11）

日期：2026-11-16。环境：macOS Apple Silicon、MySQL 8.0.42、本机隔离实例 `127.0.0.1:3407`。本轮未连接业务数据库。

## 业务范围与实现

| 流程 | 后端/前端入口 | 规则与实现 |
| --- | --- | --- |
| 只读连接排查数据 | 查询、表格增删改、DDL、同步、进程管理 | 使用最新连接配置统一校验；只读 SQL 采用查询允许列表并识别 CTE 写语句、可执行注释、文件导出；MySQL 只读事务阻止存储函数中隐藏的写入 |
| 多表同步 | `sync::run` → `sync_shard_rows` | 单列数字主键保留范围分片和 keyset；复合主键和其他表使用一次流式读取、分批写入，不使用不唯一的单列游标 |
| 心跳与重连 | `heartbeat::claim_due/check`、查询失败重试 | 根据每个连接配置的间隔独立调度；处理获取连接失败、ping 返回错误和超时；尊重自动重连开关；繁忙连接池跳过心跳；旧任务不能恢复已被手动断开的会话 |
| 查询页切换连接 | `QueryWorkspace` → `switchQueryConnection` | 保存 SQL，自动连接目标，刷新数据库和补全并清空旧结果；目标存在同名数据库时保留，否则选目标默认库；失败保留原上下文；执行、建立查询连接和切换期间禁止再次切换 |

只读配置保存后对后续操作立即生效，无需断开连接。已有 SQL 性能、取消与超时修复继续保留。

## 自动化验证

| 优先级 | 场景 | 结果 |
| --- | --- | --- |
| P0 | 只读连接直接调用单元格更新、行插入/删除、建表/改表/删表、覆盖同步、进程终止 | 全部拒绝；原记录和表结构保留 |
| P0 | 已连接会话从可读写改为只读，再恢复可读写 | 保存的最新配置立即生效，恢复后 UPDATE 成功 |
| P0 | CTE 写入、可执行注释和 SELECT 中调用修改数据的存储函数 | 解析校验或 MySQL 只读事务拦截，记录保持原值 |
| P0 | 两种复合主键（INT+INT、INT+VARCHAR），第一列每个值重复 1,300 次，跨越旧分页上限 | 每表 2,600 行；append / upsert / replace 三种模式均完整写入；逐主键及内容比对无遗漏 |
| P1 | 心跳间隔 60 秒改为 10 秒、重复心跳、连接池用满 | 按配置触发，禁止重叠，繁忙池不误触发重连 |
| P1 | ping 返回错误/超时，自动重连开/关，过期会话及手动断开 | 开启时替换连接并报告恢复；关闭时报告错误且不重连；过期结果不覆盖新会话 |
| P1 | 查询路径发生连接错误且关闭自动重连 | 不创建替代会话 |
| P0 | 查询连接切换后执行、相同数据库保留、失败回退、执行/切换中的操作拦截 | 客户端专项断言全部通过 |
| P1 | 未连接目标自动建立连接；建立连接时取消查询 | 正常切换；取消后握手完成也不发送 SQL |
| P1 | 原有查询 IPC watchdog、重复执行、取消、31 行结果、过期回复保护 | 继续通过 |

Rust 单元与真实 MySQL 回归共 **21 项通过，0 失败、0 跳过**；完整输出见 `connections-and-data-safety-rust.log`。客户端专项输出见 `connections-and-data-safety-client.log`。TypeScript、Vite 生产构建和 Rust release 构建通过。

保留的 100,000 条模拟记录、8 个 JOIN 性能回归：最终版本直接驱动中位数 176.027 ms，Finch 后端 178.752 ms（各 5 轮，debug 模式，完整数据见原始日志）。这是模拟数据结果，不能作为业务库固定耗时保证。

## 真实桌面验证

使用独立应用 `com.finch.sql.connectionqa` 和配置目录 `/tmp/finch-0311-ui`，原有 Finch 工作区未替换。两个测试账号仅能访问各自测试库。

同一查询：

```sql
SELECT CURRENT_USER() AS account, DATABASE() AS db, value FROM marker;
```

| 查询页选择 | 界面实际返回 |
| --- | --- |
| 回归 A · 可读写 | `finch_0311_a@127.0.0.1` / `finch_0311_a` / `connection-A` |
| 回归 B · 只读 | `finch_0311_b@127.0.0.1` / `finch_0311_b` / `connection-B`；工具栏显示只读 |
| B 中执行 `UPDATE marker SET value='should-not-write'` | 显示“只读连接只允许查询和查看执行计划”；再次查询仍为 `connection-B` |

切换保持编辑器 SQL，数据库选择与结果随目标连接刷新。界面未出现工具栏重叠。心跳调度边界和断开竞态由后端自动化覆盖，未对真实网络或 SSH 故障进行实测。

## 复跑与产物

```sh
npm run test:query-client
npm run build
./scripts/start-demo-db.sh
FINCH_DATA_DIR=/tmp/finch-0311-tests FINCH_REQUIRE_MYSQL_TESTS=1 cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1 --nocapture
npm run app:build
```

需要 Node 20+；本轮使用已安装的 arm64 Node 24。测试使用独立随机命名的库，成功后删除；失败测试留下的测试库也在本轮结束时清理。

交付 `release/Finch-0.3.11.app`、`release/Finch-0.3.11-arm64.dmg`。应用版本和正式 identifier `com.finch.sql` 已核验；ad-hoc 签名验证、DMG 校验和验证通过。旧版安装包保留。
