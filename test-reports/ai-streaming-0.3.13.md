# AI 流式生成与轻量输入（0.3.13）

日期：2026-11-16。范围：AI 输入、SSE 请求、增量 IPC、编辑器写入、停止及失败恢复。

## 流程与实现

`⌘P / AI 按钮 → 编辑器上方轻量输入条 → Enter → 转圈并逐段追加 SQL → 检查后手动运行`。

- 替换原有大型 AI 弹窗，不再需要在预览和编辑器之间重复插入；已有 SQL 保留，新生成内容追加在后面。
- 三种协议均发送 `stream: true`。Responses 保留消息数组，使用 `store: false`，不强制推理模型的 temperature。
- 后端按 SSE 帧解析网络块，通过独立 Tauri Channel 推送文本，不等待整个请求结束才显示。
- 正确处理跨网络块的中文 UTF-8、CRLF、多行 data、心跳注释、协议错误、流式完成和意外断流；不把 reasoning 写进 SQL。
- 编辑器按增量更新并滚动到输出位置，隐藏模型返回的 Markdown 围栏。生成时锁定编辑、执行和切换连接。
- 停止或关闭输入条会取消请求；部分 SQL 保留。关闭标签页会取消关联任务，迟到的事件不会覆盖其他标签。请求注册在正常结束、错误和取消后清理。

## 自动化验证

| 优先级 | 测试 | 结果 |
| --- | --- | --- |
| P0 | 严格 Responses HTTP 服务分别拒绝字符串输入、非 stream 请求 | 稳定复现 `Input must be a list` 与 `Stream must be set to true` |
| P0 | 服务端在首段发送后等待客户端回调，再发送剩余 SQL | 测试通过，证明前端完成前已收到增量，未整段缓冲 |
| P1 | 三种协议的增量事件、结束标记与错误事件 | 正确读取文本；忽略推理内容；截断和失败返回错误 |
| P1 | 按单字节输入中文 SSE，含 CRLF、注释和多行 data | 解析正确，无乱码 |
| P0 | 流式错误和无结束事件的断流 | 已收到的 delta 保留，报告中断 |
| P1 | 提前取消、失败和注册清理 | 没有遗留注册 |
| P0 | 客户端在完成前将 delta 写入编辑器状态 | 原 SQL + 部分生成 SQL 可见；生成状态仍为进行中 |
| P1 | 分段围栏、SQL 反引号、停止、早到取消、失败后保留内容 | 客户端专项断言通过 |
| P0 | 多标签隔离、关闭标签页、迟到回复、生成期间禁运行及禁切换连接 | 客户端专项断言通过 |

完整 Rust 回归 **29 项通过，0 失败、0 跳过**，包括 schema discovery、只读、复合主键同步、心跳、SQL 超时和取消。AI 客户端专项及原有查询客户端专项通过。TypeScript、Vite 生产构建和 Rust release 构建通过。

测试日志：`ai-streaming-0.3.13-rust.log`、`ai-streaming-0.3.13-client.log`、`ai-streaming-0.3.13-query-client.log`。

## macOS 原生窗口回归

使用独立标识 `com.finch.sql.streamqa` 和独立数据目录运行生产构建，连接本机模拟流式服务及演示数据库。

- `⌘P` 唤醒编辑器上方的单行输入，输入框、提交按钮和服务商提示可见，不遮挡 SQL。
- Enter 后显示旋转图标及停止按钮；首段 `SELECT` 在服务端发送结束事件前已出现在编辑器，连接、数据库与运行按钮暂时禁用。
- 点击停止后立即恢复输入和运行按钮，已收到的 SQL 保留，服务端确认连接关闭；没有再次发起请求。
- 模拟服务第二段返回 `response.failed` 时，显示红色错误提示并保留部分 SQL，界面恢复可操作。
- Esc 关闭输入，随后可在新查询页再次唤醒并生成。
- 正常完成后输入条自动关闭，完整 SQL 保留，未自动运行；手动点击运行，演示 MySQL 返回一行 `流式输出验证`（查询 2ms、界面总计 9ms）。此时间仅为演示查询验证，不代表用户多表 SQL 的实测性能。

原生回归中修复两处问题：移除输入条的入场动画及额外堆叠层以恢复 WebKit 正常绘制；为停止与提交按钮使用独立节点并阻止停止点击的默认行为，避免取消时按钮类型切换引发表单再次提交。

后续 schema discovery 调整为先读取完整表目录，再按请求做本地相关度筛选；相关度不足时用一次目录级 AI 选择精确表名，最后只发送选中表的字段定义。目录级请求最多带每表 40 个字段名并限制 32KB，最终定义最多展开 900 个字段，不再按固定前 18 张表截取。

## 交付检查

正式安装包：`release/Finch-0.3.13-arm64.dmg`；应用：`release/Finch-0.3.13.app`。确认正式标识 `com.finch.sql`、版本 `0.3.13`、arm64 架构；本地 ad-hoc 签名通过 `codesign --verify --deep --strict`，磁盘镜像通过 `hdiutil verify`。当前 DMG SHA-256：`ff2821f5cd78dcdb6908da81ad7f9d39fda4580822537601620895cb9eb9afb7`。此包未做 Apple 公证。

测试进程、模拟 HTTP 服务、独立 MySQL 已关闭，本次创建的虚构 Keychain 凭据已删除。用户原有运行中的 Finch 及配置未改动。真实 AI 服务商连接尚未实测，协议兼容性通过本地严格服务和原生界面端到端验证。

## 环境与复跑

仅使用本机隔离 MySQL `127.0.0.1:3407`、动态端口的本地 HTTP 测试服务及虚构 API Key。未向真实 AI 服务商发送数据库结构或产生模型调用费用。

```sh
npm run test:ai-stream
npm run test:query-client
FINCH_DATA_DIR=/tmp/finch-0313-tests FINCH_REQUIRE_MYSQL_TESTS=1 cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1 --nocapture
npm run app:build
```

使用 Node 20+。本机使用 arm64 Node 24。
