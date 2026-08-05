# CodeSesh 扫描与缓存

## 概述

CodeSesh 的扫描链路分成两个阶段：

1. 尽快从 SQLite 恢复可浏览的会话列表。
2. 在 worker 中核对真实数据源，将变化持久化到缓存和搜索索引，再发布新快照。

SQLite schema 与详情快照说明见 [sqlite-storage.md](./sqlite-storage.md)。

## 运行时结构

```text
CLI
  -> LiveScanStore
       -> scanSessions() 恢复初始快照
       -> AgentSyncEngine 协调每个 Agent 的刷新与 backfill
       -> SessionWatcher 把文件系统事件归并为 Agent 刷新
            -> scan-refresh worker 读取/解析数据源
            -> search-index worker 持久化会话、详情与索引
            -> LiveScanStore 发布内存快照和 SSE 更新
```

核心边界：

| 模块 | 职责 |
|------|------|
| `packages/core/src/discovery/scanner.ts` | 通用扫描、缓存恢复和同步增量合并 |
| `packages/core/src/agents/base.ts` | 文件型/数据库型 Agent 的变更检测模板 |
| `packages/cli/src/live-scan.ts` | 持有当前不可变快照，对外提供订阅 |
| `packages/cli/src/agent-sync-engine.ts` | 串行化单个 Agent 的 refresh/backfill，并协调发布 |
| `packages/cli/src/session-watcher.ts` | 跨平台文件监听、写入稳定性等待与事件归并 |
| `packages/cli/src/scan-refresh-worker.ts` | 在 worker thread 中扫描和解析 |
| `packages/cli/src/search-index-worker.ts` | 写入缓存、详情和搜索索引 |

## Agent 并行模型

`scanSessions()` 对所有选中的注册 Agent 调用 `scanAgentSmart()`，并通过 `Promise.all`
并行等待结果；没有固定“5 个并发”的限制。

当前数据源类型：

- 文件型：Claude Code、Codex、Grok、Kimi、Pi
- 单 SQLite 数据库型：OpenCode、Cursor、ZCode

不同 Agent 可以并行刷新；同一个 Agent 的 refresh 与 backfill 由 `AgentSyncEngine`
串行化，并为每次 operation 记录 generation。SQLite 搜索写入另由单一 job runner
排队。

## 启动流程

### 交互式 Web 模式

`LiveScanStore` 以 `deferInitialRefresh: true` 启动：

```text
loadCachedSessions()
  -> 从 agent_cache + sessions 恢复 SessionHead[] / SessionCacheMeta
  -> 启动 HTTP 服务
  -> startBackgroundRefresh()
  -> 逐 Agent 核对真实数据源并更新快照
```

缓存不存在时，初始快照可以为空；服务启动后后台初始化对应 Agent。缓存存在时，UI 先
看到已持久化快照，再通过 SSE 收到刷新结果。

### JSON 模式

`--json` 不延迟初始刷新。扫描与索引同步完成后才输出 JSON，并在输出阶段应用
`--days` / `--from` / `--to` 列表窗口。

## 变更检测

### 文件型 Agent：源枚举 + 指纹 diff

`FileSystemSessionSource.checkForChanges()` 不用缓存时间戳判断单个文件是否变化。它先由
适配器枚举当前 `SessionSourceRef[]`：

```typescript
interface SessionSourceRef {
  sessionId: string;
  sourcePath: string;
  fingerprint: string;
}
```

`diffSessionSources()` 将当前引用与缓存的会话和 `SessionCacheMeta` 比较：

- 缓存中没有该会话：新增；
- `sourcePath` 改变或 `sourceFingerprint` 不同：变更；
- 上次在本次扫描窗口内、现在却没有对应引用：删除；
- 其余会话保持原对象，不重新解析。

指纹由各适配器生成，并纳入其解析结果所依赖的事实，例如文件大小、mtime、辅助索引
mtime 或解析器版本。比较采用精确字符串相等；声明版本字段的适配器可通过提升版本主动
失效旧缓存。

`incrementalScan()` 复用本次枚举得到的 refs，只对变更/新增源调用
`scanSessionSource()`，同时移除已消失的会话。

### 数据库型 Agent：数据库 mtime + 全量重扫

`DatabaseSessionSource.checkForChanges()` 比较数据库文件 mtime 与 `agent_cache.timestamp`。
由于多个会话共享一个数据库文件，当前无法从文件状态安全推导行级变化：

- mtime 未推进：保持缓存；
- mtime 推进：报告数据源变化；
- `incrementalScan()` 退化为该 Agent 的全量 `scan()`。

这条路径已经实现；它不是待补充的示例逻辑。

## 文件监听与事件归并

`SessionWatcher` 根据每个适配器的 `getSessionWatchPlan()` 建立监听：

- 平台支持时使用递归监听；
- 不支持时遍历目录建立非递归 fallback；
- 等待写入稳定后，把路径事件归并为 Agent 名称；
- 普通 Agent 默认 debounce 200ms，空 Agent 使用更长等待，以容纳首次创建目录/数据库。

监听事件只是刷新提示，最终变化仍由指纹或数据库 mtime 验证，因此重复、合并或无关的
文件事件不会直接修改会话状态。

## 持久化与发布

刷新结果先计算 `changedSessions` 和 `removedSessionIds`，再交给 search-index worker：

```text
saveCachedSessionChanges()
  + syncSessionSearchIndexChanges()
  -> SQLite commit
  -> LiveScanStore 更新内存快照
  -> SSE sessions-updated
```

完整初始化/backfill 使用 `saveCachedSessions()` 和 `syncSessionSearchIndex()`。增量路径
只加载需要重新索引的会话详情；未变化会话不会再次调用 `getSessionData()`。

当变化量达到 `SEARCH_INDEX_BULK_SYNC_THRESHOLD` 时，FTS 使用批量重建；小批量变化由
触发器增量维护。

## 详情一致性

详情请求由 `packages/core/src/discovery/session-detail.ts` 物化：

1. 从 `sessions + messages` 读取结构化详情快照。
2. 快照消息完整且缓存指纹与当前 `SessionCacheMeta` 一致时直接返回。
3. 指纹不一致、消息缺失或会话待 reindex 时调用适配器 `getSessionData()` 回源。

所以一致性模型是“materialized detail + 源指纹失效 + 回源兜底”，不是“详情永远实时
读取源文件”。完整规则见 [sqlite-storage.md](./sqlite-storage.md#3-读取会话详情)。

## 窗口扫描与 backfill

交互式启动可以只扫描当前列表时间窗口，以缩短首次刷新。窗口扫描不会把窗口外、且无法
确认已被枚举的缓存会话误删。

为了最终覆盖完整历史，`AgentSyncEngine` 会为可用 Agent 安排无窗口 backfill：

- 从未完成全历史同步时执行；
- 距离上次全历史同步超过 24 小时时再次执行；
- 不同 Agent 的 backfill 排队运行；
- 同一个 Agent 的 backfill 与 refresh 仍保持串行。

7 天是 CLI 默认列表窗口，不是 SQLite 缓存 TTL。

## 缓存控制

```bash
# 默认：使用缓存，Web 模式后台刷新
codesesh

# 忽略缓存执行扫描
codesesh --no-cache

# 清空 SQLite 缓存后启动
codesesh --clear-cache

# 输出扫描性能追踪
codesesh --trace
```

程序化入口使用 `ScanOptions` 控制 Agent、cwd、时间窗口、缓存读写和 cache-only 行为。
具体字段以 `packages/core/src/discovery/scanner.ts` 的类型定义为准。

## 性能验证

文档不固化缺少硬件、样本规模和 commit 信息的毫秒数字。当前版本使用仓库基准脚本：

```bash
pnpm bench:perf -- --iterations 3
```

报告性能时至少记录 commit、操作系统、Node 版本、会话规模、缓存冷热状态与迭代次数。

## 正确性不变量

- 新快照只能在对应 SQLite 写入成功后发布。
- 文件型会话是否变化由 source fingerprint 决定，不由全局 mtime 截断决定。
- 数据库型 Agent 检测到数据库变化后必须全量重扫。
- 未变化会话不重新解析、不重写结构化消息。
- 缓存详情指纹过期时不得直接返回旧消息。
- 窗口扫描不能把未枚举的历史会话当作已删除。
