# CodeSesh SQLite 存储

会话列表、结构化详情、搜索索引和扫描进度存储在 `~/.cache/codesesh/codesesh.db`。
Rust 使用 rusqlite 和随二进制构建的 SQLite，开启 WAL 与外键校验。

<!-- repo-fact:cache-schema-version:start -->
- 当前 schema：`CACHE_SCHEMA_VERSION = 34`
<!-- repo-fact:cache-schema-version:end -->

入口是 `crates/codesesh-core/src/storage/mod.rs`，建表定义在
`crates/codesesh-core/src/storage/schema.sql`，升级和修复逻辑在
`crates/codesesh-core/src/storage/schema.rs`。

## 表和索引

持久 schema 包含 13 张表，其中两张为 FTS5 虚表，另有一个项目聚合视图。

| 对象 | 用途 |
|------|------|
| `cache_meta` | 版本、迁移标记和运行时 checkpoint |
| `agent_cache` | Agent 缓存写入状态 |
| `cache_initialization` | 初始化版本和全历史同步状态 |
| `pending_reindex` | 需要重新物化的会话 |
| `sessions` | 会话身份、项目身份、统计、来源和缓存元数据 |
| `messages` | 有序结构化消息、用量、费用和增量游标摘要 |
| `session_model_cost` | 按会话和模型聚合的费用 |
| `session_cost_summary` | 消息用量与费用归因所需的会话事实 |
| `message_tools` | 消息工具名，用于结构化过滤 |
| `session_file_activity` | 文件路径、操作类型、次数和最近活动时间 |
| `session_documents` | 标题、聚合文本、内容签名和已索引消息数 |
| `session_documents_fts` | 会话全文检索 |
| `session_file_activity_path_fts` | 文件路径 trigram 检索 |
| `project_groups_v` | 按项目身份聚合会话 |

`(agent_name, session_id)` 是持久化会话身份。消息和文件活动通过复合外键关联会话，删除
会话时级联清理。FTS 由内容表触发器维护，不另外保存一套消息级全文索引。

schema 33 的消息用量时间索引覆盖顺序、模型、tokens 和成本字段。schema 34 保存
`automated` 标记，并为非自动用户消息建立部分时间索引，用于活跃时段统计。

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

1. 新库直接创建 schema 34。
2. 旧库升级前通过 `VACUUM INTO` 创建带时间戳的备份。
3. 在事务中迁移公共列、旧会话头和必要派生信息，重建索引，检查外键，再写入版本。
4. 迁移失败回滚；未来版本拒绝打开，避免用旧实现覆盖未知格式。
5. 缺失的 FTS 虚表通过建表和 rebuild 恢复。

具体支持范围和一次性内容修复以 `storage/schema.rs` 和迁移测试为准。与固定 Node 参考
制品的往返检查是独立验收，不能仅凭 schema 号相同推断双向兼容。

旧表删除后的空间进入 SQLite freelist，后续写入可以复用。启动不自动压缩整个缓存。
需要手动压缩时，应先停止 CodeSesh，再运行：

```bash
sqlite3 ~/.cache/codesesh/codesesh.db 'VACUUM'
```

## 用户状态

书签和别名由 `crates/codesesh-core/src/state/` 保存到独立状态库，使用 schema 3。
状态目录支持 `CODESESH_STATE_DIR` 覆盖；默认路径按操作系统解析。清空会话缓存不应清除
用户状态。书签物化逻辑在 `crates/codesesh-core/src/bookmarks.rs`。

## 验证

```bash
cargo test -p codesesh-core storage --locked
cargo test -p codesesh-core state --locked
pnpm test:migration
pnpm test:backend
```

存储测试检查事务回滚、重启恢复、FTS、游标及迁移行为。运行时发布和取消测试位于
`crates/codesesh-core/src/runtime/tests.rs`。
