# CodeSesh 运行时架构

CodeSesh 的后端由 Rust 实现。`codesesh-core` 负责解析、查询和持久化，
`codesesh-cli` 负责参数、HTTP、安全边界和进程生命周期。React Web UI 与 Astro 产品站
继续使用 TypeScript；npm 包负责选择并启动对应平台的原生可执行文件。

## 默认 Web 模式

```text
codesesh-cli / Clap
  -> 加载价格缓存，尝试刷新并发布启动定价代际
  -> Runtime 启动专用 SQLite writer，恢复持久化快照
  -> Axum HTTP / SSE 提供已提交的数据
  -> AgentScanner 在有界 blocking 任务中扫描各 Agent
       -> 解析会话、项目身份、成本与派生信息
       -> writer 在事务中提交会话、消息、FTS 与 checkpoint
       -> 发布不可变内存快照
       -> SSE 通知 React
  -> notify 文件事件归并后触发对应 Agent 刷新
```

同一个 Agent 的扫描串行执行，不同 Agent 共享有界并发。SQLite writer 是写连接的唯一
持有者；HTTP 查询使用独立只读连接和读取事务。后台结果先提交数据库，再发布内存快照
及 SSE。缓存恢复不等于源数据已经核对，客户端可通过状态事件区分扫描阶段。

原生构建内嵌 Web 资源，执行时不依赖源码目录或单独的静态文件服务器。

## 一次性 JSON 模式

`--json` 在 blocking 任务中扫描所选 Agent，应用路径和时间范围过滤，写入缓存，然后
输出 JSON 并退出。它不启动 HTTP 服务或文件监听。扫描故障会输出诊断，并使进程以非零
状态结束。持久缓存与 `--no-cache` 使用的临时缓存都由同一 Rust 存储模块处理。

## 模块边界

| 模块 | 职责 |
|------|------|
| `crates/codesesh-core/src/agents/` | 13 个 Agent 的源格式解析及增量读取 |
| `crates/codesesh-core/src/discovery/` | 路径发现、扫描状态、窗口优先回填和 checkpoint |
| `crates/codesesh-core/src/runtime.rs` | 并发限制、任务取消、状态与刷新调度 |
| `crates/codesesh-core/src/runtime/writer.rs` | 单写者事务、提交后快照与 SSE 发布 |
| `crates/codesesh-core/src/storage/` | SQLite schema、迁移、消息、索引和成本事实 |
| `crates/codesesh-core/src/search/` | 查询语法、候选召回、文件活动和片段定位 |
| `crates/codesesh-core/src/analytics/` | Dashboard 与项目聚合 |
| `crates/codesesh-core/src/pricing/` | 价格缓存、固定代际、刷新和成本归因 |
| `crates/codesesh-core/src/state/` | 用户状态数据库与迁移 |
| `crates/codesesh-cli/src/http/` | HTTP 路由、安全校验、SSE 与请求处理 |
| `packages/contract/src/` | 浏览器安全契约和共享纯逻辑 |
| `packages/contract/src/generated/` | 从 Rust 导出的 TypeScript wire 类型 |

<!-- repo-fact:agent-source-kinds:start -->
- 文件系统: Claude Code · Codex · DSH · Grok · Kimi-Cli · Kimi-Code · Pi
- SQLite: OpenCode · Cursor · ZCode · DeepChat · Cherry Studio · MiniMax Code
<!-- repo-fact:agent-source-kinds:end -->

## 一致性边界

- `SessionHead` 在持久化和公开之前必须包含 Project Identity。
- 源扫描失败保留已提交数据；删除需要扫描结果明确确认。
- 定价快照在一轮扫描中固定。定价发布和 writer 提交通过读写锁互斥，旧代际不能提交。
- 显式刷新和退出会取消旧任务。被拒绝的批次不会推进已持久化 checkpoint。
- 详情和搜索读取已提交的结构化消息，文件变化通过后台刷新进入下一快照。
- npm launcher 不包含解析、存储或 HTTP 业务逻辑，也没有旧后端回退。

扫描行为见 [scanning-and-caching.md](./scanning-and-caching.md)，存储见
[sqlite-storage.md](./sqlite-storage.md)，制品见 [rust-packaging.md](./rust-packaging.md)。
性能数据必须按 [performance.md](./performance.md) 的方法重新测量，不能由语言变化推导提速。
