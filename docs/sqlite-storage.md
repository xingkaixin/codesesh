# CodeSesh SQLite 存储说明

## 概述

CodeSesh 现在将会话缓存和全文搜索索引统一存储在同一个 SQLite 数据库：

- 路径：`~/.cache/codesesh/codesesh.db`
- 实现：`packages/core/src/discovery/cache.ts`
- 目标：
  - 启动时快速恢复 `SessionHead[]`
  - 为 `getSessionData()` 恢复 `SessionCacheMeta`
  - 为全文搜索提供 FTS5 索引
  - 让缓存刷新和搜索索引共享同一条数据生命周期

## 表结构

### `cache_meta`

用于保存数据库级元信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | `TEXT PRIMARY KEY` | 元信息键 |
| `value` | `TEXT NOT NULL` | 元信息值 |

当前主要存储：

- `version`：当前 schema 版本，来自 `CACHE_VERSION`

### `agent_cache`

按 Agent 记录缓存时间戳。

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_name` | `TEXT PRIMARY KEY` | agent 名称，如 `claudecode` |
| `timestamp` | `INTEGER NOT NULL` | 最近一次成功写入缓存的时间戳 |

用途：

- `loadCachedSessions()` 用它判断某个 agent 的缓存是否存在
- 同时用于 7 天 TTL 校验
- `scanner.ts` 会把这个时间戳作为 `checkForChanges()` 的输入基准

### `cached_sessions`

保存会话列表页需要的轻量元数据和详情恢复所需 meta。

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_name` | `TEXT NOT NULL` | agent 名称 |
| `session_id` | `TEXT NOT NULL` | 会话 ID |
| `session_json` | `TEXT NOT NULL` | `SessionHead` 的 JSON 序列化 |
| `meta_json` | `TEXT` | `SessionCacheMeta` 的 JSON 序列化 |

主键：

- `PRIMARY KEY (agent_name, session_id)`

用途：

- 启动时恢复会话列表
- 恢复 `sessionMetaMap`
- 为增量扫描提供上一次已知会话集合

### `session_documents`

保存全文搜索的规范化文档源表。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | FTS 关联主键 |
| `agent_name` | `TEXT NOT NULL` | agent 名称 |
| `session_id` | `TEXT NOT NULL` | 会话 ID |
| `slug` | `TEXT NOT NULL` | 会话 slug |
| `title` | `TEXT NOT NULL` | 会话标题 |
| `directory` | `TEXT NOT NULL` | 会话目录 |
| `time_created` | `INTEGER NOT NULL` | 创建时间 |
| `time_updated` | `INTEGER` | 更新时间 |
| `activity_time` | `INTEGER NOT NULL` | 搜索排序和过滤用活动时间 |
| `content_text` | `TEXT NOT NULL` | 从 `SessionData.messages` 提取的全文文本 |
| `content_hash` | `TEXT NOT NULL` | 当前索引版本对应的内容签名 |
| `indexed_at` | `INTEGER NOT NULL` | 最近一次建索引时间 |

唯一约束：

- `UNIQUE(agent_name, session_id)`

用途：

- 作为 FTS 外部内容表
- 保存搜索结果展示所需字段
- 用 `content_hash` 判断是否需要重建某条会话索引

### `session_documents_fts`

FTS5 虚表，挂在 `session_documents` 上。

定义：

```sql
CREATE VIRTUAL TABLE session_documents_fts USING fts5(
  title,
  content_text,
  content='session_documents',
  content_rowid='id'
);
```

索引字段：

- `title`
- `content_text`

查询逻辑：

- 使用 `MATCH` 执行全文检索
- 使用 `bm25(session_documents_fts, 8.0, 1.0)` 排序
- 使用 `snippet(...)` 生成高亮片段

## 触发器

`session_documents_fts` 通过 3 个触发器和 `session_documents` 保持同步：

- `session_documents_ai`
  插入 `session_documents` 时向 FTS 插入对应 row
- `session_documents_ad`
  删除 `session_documents` 时从 FTS 删除对应 row
- `session_documents_au`
  更新 `session_documents` 时先删旧索引，再插入新索引

这套设计让业务代码只需要维护 `session_documents`，FTS 同步由 SQLite 完成。

## 数据流

### 1. 启动扫描

```text
CLI
  -> scanSessions()
  -> scanAgentSmart(agent)
  -> loadCachedSessions(agent.name)
  -> 从 agent_cache + cached_sessions 恢复 SessionHead[] 和 meta
  -> 立即返回会话列表
```

关键点：

- 启动路径只依赖 `cached_sessions`
- 搜索索引不会阻塞基础列表恢复

### 2. 完整扫描

```text
agent.scan()
  -> heads: SessionHead[]
  -> saveCachedSessions(agentName, heads, meta)
  -> 覆盖 agent_cache
  -> 覆盖 cached_sessions
```

关键点：

- 这一步只写列表缓存
- 还没有读取 `SessionData.messages`

### 3. 搜索建索引

```text
/api/search?q=...
  -> handleSearchSessions()
  -> syncSessionSearchIndex(agentName, sessions, agent.getSessionData)
  -> 对比 session_documents.content_hash
  -> 只为缺失或变更的会话加载 SessionData
  -> 写入 session_documents
  -> 触发器同步 session_documents_fts
  -> searchSessions()
  -> 返回 snippet + session metadata
```

关键点：

- 第一次搜索会按需补齐索引
- 搜索索引构建和缓存恢复解耦
- 只有发生变化的会话会重新读取全文内容

### 4. 增量刷新

```text
LiveScanStore.refreshAgent()
  -> agent.checkForChanges(...)
  -> agent.incrementalScan(...)
  -> saveCachedSessions(...)
  -> syncSessionSearchIndex(...)
```

关键点：

- 监听文件变化后，列表缓存和搜索索引一起更新
- 搜索和列表共享同一份会话集合

## 读写职责

| 场景 | 读取表 | 写入表 |
|------|--------|--------|
| 启动恢复列表 | `agent_cache`, `cached_sessions` | 无 |
| 保存扫描结果 | 无 | `agent_cache`, `cached_sessions` |
| 构建搜索索引 | `session_documents` | `session_documents` |
| 执行全文搜索 | `session_documents_fts`, `session_documents` | 无 |
| 清空缓存 | 全部 | `agent_cache`, `cached_sessions`, `session_documents` |

## 一致性策略

### 列表缓存

- 以 agent 为单位整体覆盖
- `saveCachedSessions()` 在事务里先删旧数据，再写入新数据

### 搜索索引

- 以单会话为单位增量更新
- `content_hash` 基于 `SessionHead` 核心字段生成
- 如果 `SessionHead` 没变化，默认跳过全文重建

### 详情内容

- `getSessionData()` 仍然实时读取源文件或源数据库
- SQLite 当前存的是搜索用规范化文本，不是详情页完整消息快照

## 现阶段边界

当前实现有两个明确边界：

1. 首次搜索某个大库时，索引会按需建立，这次请求会更重
2. `content_hash` 基于 `SessionHead`，如果底层消息内容变化但 head 未变化，索引刷新依赖增量扫描重新产出新的 head

这两个边界都属于当前设计下的可接受权衡，因为启动速度和实现复杂度更重要。

## 相关代码

- `packages/core/src/discovery/cache.ts`
- `packages/core/src/discovery/scanner.ts`
- `packages/cli/src/api/handlers.ts`
- `packages/cli/src/live-scan.ts`
