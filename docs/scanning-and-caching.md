# CodeSesh 扫描与缓存

## 启动和发布

Web 模式先从 SQLite 恢复会话快照，再由 Rust 后台任务核对源数据。空缓存可以先返回空列表，
客户端通过扫描状态和 SSE 接收后续结果。`--json` 完成一次扫描后输出并退出。

```text
Clap 参数与 PathEnvironment
  -> AgentScanner / discovery
  -> 有界 blocking 扫描任务
  -> ScanBatch（upserts、removed、checkpoint、pricing ticket）
  -> 专用 SQLite writer 提交事务
  -> 不可变 SessionHead 快照
  -> SSE
```

| 代码 | 职责 |
|------|------|
| `crates/codesesh-core/src/discovery.rs` | 一次性扫描、过滤与公开 Agent 信息 |
| `crates/codesesh-core/src/discovery/paths.rs` | 各平台默认路径和环境变量覆盖 |
| `crates/codesesh-core/src/discovery/incremental.rs` | 恢复 baseline、增量状态和回填批次 |
| `crates/codesesh-core/src/discovery/backfill.rs` | 源清单、窗口优先顺序和可恢复 checkpoint |
| `crates/codesesh-core/src/runtime.rs` | 单 Agent 串行、跨 Agent 有界并发、取消和状态 |
| `crates/codesesh-core/src/runtime/watcher.rs` | notify 监听、路径归一化和监听根重建 |
| `crates/codesesh-core/src/runtime/writer.rs` | 事务写入和提交后发布 |

## 数据源与增量读取

<!-- repo-fact:agent-source-kinds:start -->
- 文件型：Claude Code、Codex、DSH、Grok、Kimi-Cli、Kimi-Code、Pi
- 单 SQLite 数据库型：OpenCode、Cursor、ZCode、DeepChat、Cherry Studio、MiniMax Code
<!-- repo-fact:agent-source-kinds:end -->

文件事件是刷新提示，不直接修改会话。适配器根据变更路径、会话关系及源状态决定需要重读的
会话；父子会话和共享索引变化会扩展受影响范围。无法安全缩小范围时重新扫描相关来源。

数据库适配器读取各自的会话键、内容签名或数据库快照。Cursor、OpenCode/ZCode 和桌面
数据库分别保留增量状态，不把数据库 mtime 变化直接解释成某一行删除。可验证的删除才进入
`ScanBatch.removed`；源不可用或解析失败不会作为清空缓存的理由。

同一 Agent 的 scanner 由互斥锁串行访问。不同 Agent 的 blocking 工作受运行时 semaphore
限制。SQLite 写入另由唯一 writer 排队，不跨线程共享写连接。

## 监听与取消

notify 监听已存在的数据根目录；根目录尚未创建时监听最近的现有祖先。目录创建、替换、
移动或删除后重新协调监听范围。路径会先规范化，SQLite `-shm` 变化被忽略，数据库及 WAL
变化继续触发核对。重复路径归并为一个后续刷新请求。

普通文件事件安排下一轮刷新，不持续中断正在处理的批次，避免高频追加使扫描无法完成。
显式刷新、定价代际切换和退出会使旧扫描失效。writer 在提交前检查取消状态；定价票据在
整个数据库提交和快照发布期间持有读锁，防止定价发布与旧结果提交竞争。

被拒绝批次的 scanner 会丢弃未提交的增量状态，并从持久化 baseline 恢复。

## 回填和 checkpoint

首次核对按照启动窗口优先处理源清单，再继续覆盖完整历史。回填按批次推进，checkpoint
记录清单签名、偏移、epoch 和定价代际。只有清单及代际一致时才能恢复偏移；否则重新核对。
批次和 checkpoint 在同一事务中提交，事务失败不能推进进度。

不完整批次必须推进 checkpoint，运行时会拒绝没有进展的循环。列表默认时间窗口不等于缓存
TTL，也不会使窗口外的历史会话自动失效。删除判断必须基于完整性信息，不能只看当前分页。

## 价格与详情

价格在启动时从缓存和内置快照加载，缺失或过期时尝试远程刷新。网络失败保留可用价格。
一个扫描批次使用固定价格快照。新代际发布后，scanner 清理依赖旧定价的增量状态并重新计算；
已有记录成本仍优先于模型估算。价格缓存和会话缓存是独立文件。

详情请求读取 SQLite 中已提交的消息，索引消息数和游标用于校验与客户端增量更新。
HTTP 不直接写源 Agent 数据。源变化由扫描提交后进入详情、搜索和统计。

## 缓存控制

```bash
codesesh
codesesh --no-cache
codesesh --clear-cache
codesesh --json --days 0
codesesh --trace
```

`--no-cache` 使用临时缓存支持本轮查询；`--clear-cache` 清理会话缓存，书签与别名存储在
独立用户状态库。详细表结构见 [sqlite-storage.md](./sqlite-storage.md)。

## 验证

```bash
pnpm build:web
cargo test --workspace --locked
pnpm test:backend
pnpm prepare:reference
pnpm test:backend:compare
```

单元测试检查事务、增量状态和回填不变量；进程契约检查真实 CLI、HTTP、SSE 和重启行为。
对照工具使用固定的 Node 参考制品，不作为生产运行时依赖。性能测量方法见
[performance.md](./performance.md)。
