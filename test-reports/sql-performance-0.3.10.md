# SQL 执行性能修复与回归记录（0.3.10）

日期：2026-11-16。范围：SQL 解析 → 连接等待 → 执行/读取 → IPC → 结果网格。
验证环境：macOS Apple Silicon、MySQL 8.0.42，本机隔离实例 `127.0.0.1:3407`。未连接或修改业务数据库。

## 根因与修复

P0：旧 SQL 拆分器在每一行开头用 `upper[..9]` 判断 DELIMITER；中文 CASE 字符串位于行首时，第 9 字节可能落在汉字内部，Rust panic。SQL 尚未发送到 MySQL，Tauri 调用没有正常回复，界面一直 loading。

修复前用最小 SQL（CASE 分支中的“手动调拨”）稳定复现：`end byte index 9 is not a char boundary`，退出码 101。提供的完整 SQL 已作为解析回归样例保留。

修复措施：

- 新增 UTF-8 安全的单次扫描器，覆盖中文、多语句、引号转义、块/行注释和 DELIMITER。
- IPC 查询边界捕获 panic，返回明确错误。
- 查询期限覆盖连接等待、会话准备和完整结果读取；超时结束等待并请求 KILL，关闭失效查询连接。
- 取消排队查询使用独立取消通知，不使用握手线程 ID，不等待已占满的连接池；所有出口清理执行注册。
- 缓存 LIMIT 正则，识别 LIMIT … OFFSET …；查询历史写盘移出结果返回路径。
- 前端拦截重复执行和过期结果，并增加 IPC 响应超时保护。
- 耗时提示区分连接等待、准备、执行及读取、客户端往返。

## 验证结果

| 验证项 | 结果 |
| --- | --- |
| 中文 CASE + 8 个 JOIN，100,000 条模拟源记录 | 返回 31 行、11 列，中文值正确 |
| 首轮 Debug 同机直接驱动 / Finch，各 5 次中位数 | 164.081 ms / 165.029 ms |
| 最终版本 Debug 同机直接驱动 / Finch，各 5 次中位数 | 180.418 ms / 196.473 ms |
| Release 桌面端真实 Tauri IPC 与渲染 | 界面显示 31 行；执行及读取 2 ms、后端总计 6 ms |
| 桌面端 `SELECT SLEEP(30)`，超时设置 3 秒 | 3.00 秒显示 CLIENT_TIMEOUT，运行按钮恢复 |
| 桌面端超时后 `SELECT 42 AS recovered` | 返回 42，后端总计 1 ms |
| Rust 单元/真实 MySQL 回归 | 17 项通过，0 失败；包括大结果截断、同步/DDL/转储原有回归 |
| 客户端专项测试 | 6 类场景通过：正常结束、watchdog 取消、关闭超时、重复运行、31 行返回、过期回复 |
| TypeScript / 前端生产构建 / Rust release 构建 | 通过 |

Debug 和 Release 的数字来自不同执行模式，不能直接据此计算提速倍数。直接驱动对比采用同一台机器、同一套模拟数据；最终一轮伴随桌面及构建活动，存在调度抖动，完整原始输出见 `sql-performance-rust-tests-final.log`，首轮输出见 `sql-performance-rust-tests.log`。桌面端数字来自结果栏。业务库的网络、索引和数据分布没有在本轮进行实测，不承诺其固定耗时。

## 复跑

使用 Node 20+：

```sh
npm run test:query-client
npm run typecheck
./scripts/start-demo-db.sh
FINCH_DATA_DIR=/tmp/finch-performance-test-data FINCH_REQUIRE_MYSQL_TESTS=1 cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1 --nocapture
```

`FINCH_REQUIRE_MYSQL_TESTS=1` 用于在数据库不可用时明确失败，避免把跳过集成测试当成通过。回归在新建的 `finch_perf_*` 库中准备模拟数据，成功后删除测试库。

桌面验证使用独立 bundle identifier `com.finch.sql.performanceqa` 和 `/tmp/finch-performance-ui` 配置目录，不覆盖用户正在使用的应用工作区。

## 产物

- `release/Finch-0.3.10-arm64.dmg`
- `release/Finch-0.3.10.app`

应用采用本地 ad-hoc 签名；未进行 Apple Developer 公证。原有 0.3.9 安装包和正在运行的应用未替换。
