# CodeSesh SQLite 存储

会话列表、结构化详情、搜索索引和扫描进度存储在 `~/.codesesh/codesesh.db`。
Rust 使用 rusqlite 和随二进制构建的 SQLite，开启 WAL 与外键校验。

<!-- repo-fact:cache-schema-version:start -->
- 当前 schema：`CACHE_SCHEMA_VERSION = 42`
<!-- repo-fact:cache-schema-version:end -->

入口是 `crates/codesesh-core/src/storage.rs`，建表定义在
`crates/codesesh-core/src/storage/schema.sql`，升级和修复逻辑在
`crates/codesesh-core/src/storage/schema.rs`。

## 表和索引

持久 schema 包含 17 张表，其中三张为 FTS5 虚表，另有一个项目聚合视图。

| 对象 | 用途 |
|------|------|
| `cache_meta` | 版本、迁移标记和运行时 checkpoint |
| `source_fingerprints` | 按 Agent、类型和键增量保存的文件/数据库/空来源指纹 |
| `agent_cache` | Agent 缓存写入状态 |
| `cache_initialization` | 初始化版本和全历史同步状态 |
| `pending_reindex` | 需要重新物化的会话 |
| `sessions` | 会话身份、项目身份、统计、来源和缓存元数据 |
| `messages` | 有序结构化消息、用量、费用和增量游标摘要 |
| `session_model_cost` | 按会话和模型聚合的费用 |
| `session_cost_summary` | 消息用量与费用归因所需的会话事实 |
| `session_usage_bucket` | 按会话、15 分钟时间桶、模型和费用来源预聚合的消息用量与费用 |
| `message_tools` | 消息工具名，用于结构化过滤 |
| `session_file_activity` | 文件路径、操作类型、次数和最近活动时间 |
| `session_documents` | 标题、内容签名和已索引消息数 |
| `message_locator` | 从消息 rowid 定位会话 rowid 与消息序号的索引表 |
| `message_fts` | 消息全文检索，无内容表，含 `code_tokens` 拆词列，rowid 对应 `messages.rowid` |
| `session_title_fts` | 会话标题全文检索，无内容表，含 `code_tokens` 拆词列，rowid 对应 `sessions.rowid` |
| `session_file_activity_path_fts` | 文件路径 trigram 检索 |
| `project_groups_v` | 按项目身份聚合会话 |

`(source_node_id, agent_name, session_id)` 是持久化会话身份。消息和文件活动通过复合外键关联会话，删除
会话时级联清理。文件路径 FTS 由内容表触发器维护。`message_fts` 和 `session_title_fts` 均不保存原文，由 writer
在写入或删除会话、消息时同步维护，只索引新增或变化的记录；汉字逐字切分，使中文子串可以按短语
查询，同时在 `code_tokens` 列写入 camelCase/缩写拆词结果以支持代码标识符检索。搜索先通过标题和消息 FTS
结合基础过滤条件收集候选会话，再在 Rust 侧按标题命中和最近活动时间排序并复用到片段生成，避免全表扫描与重复 FTS 查询；含汉字的词按结果顺序逐个会话核对原文子串，凑够条数即停。片段围绕首个命中窗口从 `content_text` 生成。

schema 34 保存 `automated` 标记，并为非自动用户消息建立部分时间索引，用于活跃时段统计。

schema 35 将展示版本、文件摘要和原始仓库证据保存在 `head_meta_json`，快照不再读取包含定价明细的
`meta_json`。展示元数据与会话在同一事务发布；定价元数据由定价路径校验。

schema 37 将 `messages.parts_json` 存为 zstd 压缩的 BLOB，压缩后不更小的短内容仍存为文本，
读取时两种编码都接受。编码入口在 `crates/codesesh-core/src/storage/body.rs`。

schema 38 新增 `session_usage_bucket`。`storage::facts::write` 重写会话成本事实时，按会话、
15 分钟时间桶、模型和费用来源重建该会话的桶行；Dashboard 和项目统计按请求窗口读取桶，
不再逐条读取消息和解析 `tokens_json`，schema 33 的消息用量时间索引随之删除。进程不常驻
成本事实，单次请求的内存只随窗口内的桶数增长。`idx_sessions_visible` 覆盖会话身份和
`publication_id`，成本查询排除未发布会话时不回表读取会话行。升级时同时删除 schema 37
开发构建为进程内缓存加入的 `session_cost_summary.revision`。

schema 39 为 `message_fts` 与 `session_title_fts` 增加 `code_tokens` 列，并将 `session_title_fts`
改为由 writer 同步的无内容 FTS5 虚表（支持标题中文子串、前缀与 camelCase 检索，消除搜索全表扫描）；
同时删除严格冗余的 `idx_sessions_activity`（被 `idx_sessions_heads` 前缀覆盖）与
`idx_file_activity_project_latest`（被 `idx_file_activity_project_latest_ordered` 覆盖）。

schema 40 对 `messages.content_text` 复用相同的 zstd BLOB/文本混合压缩（读取路径透明解压），
并在 `sessions` 上新增 `has_unmatched_pricing_meta` 列及部分索引 `idx_sessions_unmatched_pricing_meta`，
使 `GET /api/pricing/unmatched` 仅访问存在未匹配 head 定价输入的会话，避免全表扫描 `meta_json`。

schema 42 新增 `source_fingerprints` 表，将原本内联在 `cache_meta` 中 `rust_source_state:<agent>` JSON 里的
`files`、`databaseSessions` 和 `emptySources` 拆出按单键增量更新，避免每次单文件增量扫描或分页回填都重写整份大 JSON。

现行时区偏移都是 15 分钟的整数倍，Web 窗口和对比窗口从本地自然日边界开始，因此按桶归因与
逐条消息归因结果一致；直接调用 API 传入非对齐边界时，误差不超过一个桶。

## 读写与发布

Web 运行时只有一个专用 SQLite writer。Agent 扫描线程产出完整批次，不直接修改缓存。
writer 在同一事务中更新会话、消息、派生事实、FTS 和 checkpoint；成功后读取新的会话头
快照，再发布内存快照及 SSE。

```text
AgentScanner -> ScanBatch
  -> 取消状态和定价票据检查
  -> SQLite transaction
       sessions / messages / costs / tools / file activity / documents / checkpoint
  -> commit
  -> 不可变 SessionHead 快照
  -> SSE
```

HTTP 读取使用独立只读连接，并在读取事务内完成查询，避免一个响应混合不同提交。
详情读取入口位于 `crates/codesesh-core/src/storage/read.rs`。消息数校验使用实际已物化的
`session_documents.indexed_message_count`，不能拿源记录统计的 `stats.message_count`
代替；有些 Agent 会合并多个源记录为一条可展示消息。

时间保留毫秒的小数精度。消息游标和 JSON 数值序列化遵循现有 API 契约，不把浮点数
格式变化当作消息内容变更。

## 迁移和恢复

打开数据库时先读取 `PRAGMA user_version`，兼容旧库的 `cache_meta.version`：

1. 新库直接创建 schema 42。
2. schema 35 及更早的旧库升级前通过 `VACUUM INTO` 创建带时间戳的备份；迁移重建带来源维度的键，早于 schema 35 的库同时回填 `head_meta_json`。
3. 在事务中迁移公共列、旧会话头和必要派生信息，重建索引，检查外键，再写入版本。
4. 迁移失败回滚；未来版本拒绝打开，避免用旧实现覆盖未知格式。
5. 缺失或旧结构的 FTS 虚表通过建表和 rebuild 恢复；`message_fts` 从 `messages` 分批重建，可中断续做，完成后重建 `session_title_fts`。
6. schema 36–41 升级到 42 不重建表：先写入新版本号、按需添加列、部分索引、`message_locator` 与 `source_fingerprints` 表（并将 `rust_source_state:*` 中内联的指纹迁入 `source_fingerprints` 后剥离），删除冗余索引，按需分批就地回填 `has_unmatched_pricing_meta`、压缩旧的文本 `parts_json` 与 `content_text`、回填 `session_usage_bucket`，并通过可中断续做机制重建 `message_fts` 与 `session_title_fts`。
7. 打开文件库时，若空闲页至少占四分之一且超过 64 MB，执行一次 `VACUUM`；磁盘空间不足等失败只报告进度，不阻止打开。

具体支持范围和一次性内容修复以 `storage/schema.rs` 和迁移测试为准。schema 36 不支持
再由 schema 35 的旧版本打开；用户状态使用 schema 5。

旧表删除后的空间进入 SQLite freelist，后续写入可以复用；空闲页达到第 7 步的阈值时，
打开数据库会自动压缩。需要立即压缩时，应先停止 CodeSesh，再运行：

```bash
sqlite3 ~/.codesesh/codesesh.db 'VACUUM'
```

## 用户状态

书签、别名和模型价格覆盖规则由 `crates/codesesh-core/src/state/` 保存到独立状态库 `state.db`，使用 schema 5。
状态目录支持 `CODESESH_STATE_DIR` 覆盖；默认位于 `~/.codesesh/state.db`（Windows 为 `%USERPROFILE%\.codesesh\state.db`）。清空会话缓存不应清除
用户状态。书签物化逻辑在 `crates/codesesh-core/src/state/bookmarks.rs`。

`model_price_overrides` 按归一化模型键 `model_key` 保存模型价格覆盖规则（`remap` 记录目标官方模型 `target_model`，`manual` 记录 `input_per_1m`、`output_per_1m`、`cache_read_per_1m`、`cache_write_per_1m`），并记录用户确认过的官方价快照 `acknowledged_official_hash` 与 `acknowledged_official_json`。旧库升级前对非空 `bookmarks`、`session_aliases` 和 `model_price_overrides` 创建时间戳备份，并将版本号升级到 schema 5。

## 验证

```bash
cargo test -p codesesh-core storage --locked
cargo test -p codesesh-core state --locked
cargo test -p codesesh-core migration --locked
pnpm test:backend
```

存储测试检查事务回滚、重启恢复、FTS、游标及迁移行为。运行时发布和取消测试位于
`crates/codesesh-core/src/runtime/tests.rs`。


## 数据目录迁移

默认会话数据库、用户状态数据库、模型价格缓存和日志统一存放在 `~/.codesesh/`。
Windows 使用 `%USERPROFILE%\.codesesh\`。`CODESESH_STATE_DIR` 和 `CODESESH_LOG_DIR`
继续覆盖对应目录；`CODESESH_STATE_STORE=memory` 不迁移磁盘状态。
`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`APPDATA` 和 `LOCALAPPDATA` 仅用于定位旧默认文件。

首次发现需要迁移的数据时，CLI 列出来源并要求确认旧版本已经退出，默认取消。
无交互终端时不会等待输入：先退出旧版本，再传入 `--migrate-data` 明确确认。
`--help` 和 `--version` 不创建目录或迁移。JSON 模式的所有提示只写 stderr。

迁移、校验、清理分别显示进度；无法取得可靠总量的数据库完整性检查显示等待指示和耗时。
SQLite 使用 Backup API 保留 WAL 中的数据，随后检查完整性、schema 和表内容；普通文件比较
SHA-256。目标正式发布并持久化迁移记录后，才删除已验证的旧文件。只删除空的旧目录，
未知文件、变化的源文件以及删除失败的具体路径都会列出。旧版本不遵守新迁移锁，用户必须
先退出旧版本；文件检查不能证明旧进程不会在之后继续写入。

`migration-v1.json` 按目标文件记录处理结果与清理状态。清理失败不会重复迁移；下次启动
只核验残留源文件并尝试删除。源文件变化时转为手动处理。新文件后来被删除时，不重新导入
旧副本。迁移记录缺失但目标已存在时，始终使用目标，保留旧文件并补写记录，不自动比较、
覆盖或合并。若同时删除记录和目标而保留旧文件，下次启动会将其识别为尚未迁移的数据。

`--clear-cache` 跳过旧会话库导入并保留它供手动清理；`--no-cache` 使用临时会话库，
以后启用持久缓存时再处理旧库。JSON 模式不迁移用户状态库。迁移失败时源数据保留，错误
包含具体路径；清理失败不阻止使用已验证的新数据。

## Hub 来源身份

schema 36 在会话及关联表的复合键中加入 `source_node_id`。旧数据归属保留的本地来源 `local`，远程来源使用独立身份。同一 Agent 的相同会话 ID 可存在于不同来源中。

schema 35 及更早版本升级前保留数据库备份，事务重建关联键并检查外键完整性。已经存在的 `head_meta_json` 不重新生成。用户状态 schema 4 同样扩展收藏和自定义标题的键，不改变原有本地映射；schema 5 的 `model_price_overrides` 保存在运行 Web 服务的实例（单机或 Hub）本地 state.db 中，不随 Hub/Worker 协议同步。升级后的库不支持用旧版本直接打开。
