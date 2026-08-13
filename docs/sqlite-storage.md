# CodeSesh SQLite 存储

## 概述

CodeSesh 将会话列表、详情快照、搜索索引和增量同步状态存储在同一个 SQLite 数据库：

- 路径：`~/.cache/codesesh/codesesh.db`
<!-- repo-fact:cache-schema-version:start -->
- 当前 schema：`CACHE_SCHEMA_VERSION = 24`
<!-- repo-fact:cache-schema-version:end -->
- 稳定导出入口：`packages/core/src/discovery/index.ts`
- 实现目录：`packages/core/src/discovery/cache/`

`cache.ts` 只是公共 barrel。数据库连接、schema、会话持久化和搜索实现分别位于
`cache/` 下的模块中。

## 模块职责

| 模块 | 职责 |
|------|------|
| `cache/db.ts` | 缓存路径、进程内连接生命周期、共享查询辅助函数、schema/FTS 检查状态 |
| `cache/schema.ts` | 建表、迁移、事务边界、FTS 完整性检查 |
| `cache/sessions.ts` | 会话列表和详情快照的读取、写入与清理 |
| `cache/messages.ts` | `sessions` / `messages` 行与领域对象之间的转换 |
| `cache/publication-staging.ts` | 大批量详情发布的影子载荷与中断回收 |
| `cache/search-index-writer.ts` | 详情、工具、文件活动与全文索引的同步写入 |
| `cache/search.ts` | 搜索查询与结构化过滤 |
| `cache/search-query-parser.ts` | 搜索语法解析 |
| `cache/file-activity.ts` | 文件活动查询 |
| `cache/project-groups.ts` | 项目聚合查询 |

## Schema 清单

当前 schema 创建 14 张表（其中 2 张是 FTS5 虚表）和 1 个视图。

### 生命周期与同步状态

| 表 | 用途 |
|----|------|
| `cache_meta` | schema 版本与一次性迁移标记 |
| `agent_cache` | 每个 Agent 最近一次缓存写入时间；数据库型 Agent 以此作为 mtime 比较基准 |
| `cache_initialization` | 每个 Agent 的缓存初始化版本与最近一次全历史同步时间 |
| `pending_reindex` | 标记因解析器升级而必须重新物化的会话 |

### 当前会话模型

| 表 | 用途 |
|----|------|
| `sessions` | `SessionHead`、项目身份、统计数据、源路径与 `SessionCacheMeta` |
| `messages` | 详情页使用的结构化消息快照 |
| `message_tools` | 从消息中提取的工具名，用于结构化过滤 |
| `session_file_activity` | 会话涉及的文件路径、操作类型、次数与最近时间 |

`messages` 和 `session_file_activity` 通过复合外键关联 `sessions`，删除会话时级联清理。

### 搜索索引

| 表 | 类型 | 用途 |
|----|------|------|
| `session_file_activity_path_fts` | trigram FTS5 虚表 | 文件路径匹配 |
| `session_documents` | 普通表 | 会话标题、聚合文本、内容签名与已索引消息数 |
| `session_documents_fts` | FTS5 虚表 | 会话级标题和聚合文本搜索 |
| `search_index_publication_entries` | 普通表 | 大批量发布提交前暂存序列化详情；提交或回滚后清空 |

两个 FTS 表都由对应内容表的 insert/update/delete 触发器维护。批量变化达到阈值时，
`runSearchIndexWrite()` 会在写事务中重建会话文档索引；文件路径索引仍由触发器增量维护。
搜索先由会话文档索引召回和排序，再在候选会话的消息纯文本中定位首条命中消息，不再
为同一批内容维护第二套消息级倒排索引。

Schema 24 删除旧消息索引后，SQLite 会把对应页计入 freelist，后续写入可以直接复用；
数据库文件的字节大小不会因此立即下降。物理压缩需要重写整个数据库，因此不在启动迁移
中自动执行，避免把一次性磁盘回收变成阻塞式维护。

### 项目聚合

| 对象 | 类型 | 用途 |
|------|------|------|
| `project_groups_v` | 视图 | 从 `sessions` 按项目身份聚合来源、会话数与最近活动时间 |

### 迁移兼容表

| 表 | 状态 |
|----|------|
| `cached_sessions` | 旧 JSON 会话缓存；迁移到 `sessions` 时读取，当前运行时不再写入 |
| `project_sessions` | 旧项目映射；仅供旧 schema 迁移与兼容，当前视图读取 `sessions` |

这两张表仍由最新 schema 创建，以保证旧数据库可以原地升级；不能据此把它们当作当前
读写路径。

## 数据流

### 1. 恢复会话列表

```text
LiveScanStore.initialize()
  -> scanSessions({ cacheOnly: true })
  -> loadCachedSessions(agentName)
  -> agent_cache + sessions
  -> 恢复 SessionHead[] 与 SessionCacheMeta
```

交互式 CLI 先发布缓存快照并启动 HTTP 服务，再由 `AgentSyncEngine` 在后台刷新。
`--json` 路径不采用延迟刷新，会在输出前完成扫描。

### 2. 刷新并持久化

```text
SessionWatcher / 初始后台刷新
  -> AgentSyncEngine
  -> scan-refresh worker
  -> 计算新增、变更、删除
  -> search-index worker
       -> saveCachedSessions() / saveCachedSessionChanges()
       -> syncSessionSearchIndex() / syncSessionSearchIndexChanges()
  -> 发布新的内存快照与 SSE 事件
```

搜索索引 worker 在同一 SQLite 事务中提交会话 head 与详情后，`AgentSyncEngine` 才发布
新内存快照。大批量详情先分块写入影子表，最终事务再流式提升到正式表，避免为控制内存而
提前暴露部分新详情。

完整写入会整体协调某个 Agent 的会话集合；精确刷新只 upsert 变更会话并删除已消失
会话。需要重新索引的会话才会调用适配器的 `getSessionData()`，随后由缓存事务和索引
事务更新：

- `sessions`
- `messages`
- `message_tools`
- `session_file_activity`
- `session_documents`
- 对应 FTS 索引

### 3. 读取会话详情

`packages/core/src/discovery/session-detail.ts` 是详情读取入口：

```text
materializeSessionDetailResponse()
  -> loadCachedSessionRawEntry()
  -> 缓存完整且 sourceFingerprint 与当前 meta 一致
       -> 从 sessions + messages 流式返回 materialized detail
     否则
       -> agent.getSessionData() 回源解析
```

因此当前一致性语义不是“列表缓存、详情始终实时读取”，而是：

- 默认从结构化详情快照读取；
- 文件型 Agent 的当前源指纹与缓存指纹不一致时回源；
- 缓存消息缺失或被 `pending_reindex` 标记时回源；
- 后续索引同步会重新物化变更后的详情。

## 变更与失效

- 文件型 Agent 将源路径和 `sourceFingerprint` 写入 `SessionCacheMeta`；指纹包含适配器
  认为会影响解析结果的文件状态与解析版本。
- 数据库型 Agent 无法按会话建立文件指纹，使用数据库文件 mtime 判断库是否变化；
  发生变化时执行该 Agent 的全量重扫。
- `cache_initialization.index_version` 控制缓存是否可用于增量刷新。
- 窗口化启动后的刷新会检查最近一次全历史同步；从未同步或已超过 24 小时时安排无窗口
  backfill。这不是缓存 TTL，也不会因为缓存“满 7 天”而丢弃数据。
- `--clear-cache` 清空会话、搜索内容和 Agent 缓存/初始化状态，并删除旧的
  `scan-cache.json`。

## 迁移与恢复

`withCacheDb()` 首次打开当前数据库路径时创建进程内连接并调用 `ensureSchema()`：

1. 读取 `PRAGMA user_version`，旧数据库还会兼容读取 `cache_meta.version`。
2. 破坏性迁移前备份有数据的缓存。
3. 按版本顺序运行迁移。
4. 创建最新 schema，并更新 `user_version` 和 `cache_meta.version`。

迁移实现与目标版本必须以 `cache/schema.ts` 为准；文档不引用易漂移的源码行号。
后续读写复用同一模块实例内的连接；worker thread 各自持有独立连接，不跨线程共享。
搜索边界在每个连接上首次使用时检查 FTS schema，缺表或触发器时重建对应索引。
`clearCache()` 和 CLI shutdown 会关闭连接；下一次访问会重新建连并执行上述检查。

## 相关代码

- `packages/core/src/discovery/index.ts`
- `packages/core/src/discovery/cache/`
- `packages/core/src/discovery/session-detail.ts`
- `packages/core/src/agents/base.ts`
- `packages/core/src/discovery/scanner.ts`
- `packages/cli/src/agent-sync-engine.ts`
- `packages/cli/src/search-index-worker.ts`
