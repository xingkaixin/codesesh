# CodeSesh 扫描与缓存机制说明文档

## 概述

本文档详细说明 CodeSesh 的会话扫描、并行处理和缓存机制的设计理念与实现细节。

SQLite 表结构和搜索索引数据流见 [sqlite-storage.md](./sqlite-storage.md)。

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        扫描流程                              │
├─────────────────────────────────────────────────────────────┤
│  CLI 启动                                                   │
│     │                                                       │
│     ▼                                                       │
│  ┌──────────────────┐    ┌──────────────────┐              │
│  │   scanSessions   │───▶│  Agent 并行扫描   │              │
│  │   (入口函数)      │    │  (5个并发)       │              │
│  └──────────────────┘    └──────────────────┘              │
│                                   │                         │
│                    ┌──────────────┼──────────────┐         │
│                    ▼              ▼              ▼         │
│              ┌─────────┐   ┌─────────┐   ┌─────────┐      │
│              │ Claude  │   │  Codex  │   │  Kimi   │      │
│              │ (文件)  │   │ (文件)  │   │ (文件)  │      │
│              └─────────┘   └─────────┘   └─────────┘      │
│                                                    │       │
│              ┌─────────┐   ┌─────────┐            │       │
│              │OpenCode │   │ Cursor  │────────────┘       │
│              │ (SQLite)│   │ (SQLite)│                    │
│              └─────────┘   └─────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

## 2. 并行扫描机制

### 2.1 Agent 级别并行

所有 Agent 同时扫描，而非串行执行：

```typescript
// 并行扫描所有 Agent
const scanPromises = agentsToScan.map((agent) =>
  scanAgentSmart(agent, options, onProgress)
);
const results = await Promise.all(scanPromises);
```

**性能对比**：
- 串行扫描：~10.6s (Agent 一个接一个)
- 并行扫描：~5s (所有 Agent 同时进行)

### 2.2 会话级别扫描（当前实现）

每个 Agent 内部仍然是串行扫描文件：

```typescript
// Claude Code - 串行读取项目目录
for (const projectDir of this.listProjectDirs()) {
  for (const file of this.listJsonlFiles(projectDir)) {
    const head = this.parseSessionHead(file, projectDir);
    // ...
  }
}
```

**未来优化方向**：
- 使用 `Promise.all` 并行读取多个文件
- 使用 Worker Threads 处理 CPU 密集型解析

## 3. 智能刷新机制 (Smart Refresh)

### 3.1 设计理念

解决缓存的两大痛点：
1. **启动速度**：缓存可立即返回结果（14ms）
2. **数据新鲜度**：后台检测变更并增量更新

```
┌────────────────────────────────────────────────────────────┐
│                     智能刷新流程                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│   启动                                                      │
│     │                                                       │
│     ▼                                                       │
│   ┌─────────────┐    是    ┌─────────────┐                │
│   │  缓存存在？  │────────▶│  立即返回    │ 14ms          │
│   └─────────────┘         └─────────────┘                │
│     │ 否                         │                        │
│     ▼                            ▼                        │
│   ┌─────────────┐         ┌─────────────┐                │
│   │  完整扫描    │         │  后台检测    │                │
│   │  (10.6s)   │         │  文件变更    │                │
│   └─────────────┘         └─────────────┘                │
│                                    │                        │
│                                    ▼                        │
│                           ┌─────────────┐                 │
│                           │  增量更新    │                 │
│                           │  (100-500ms)│                 │
│                           └─────────────┘                 │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 3.2 实现细节

#### 3.2.1 变更检测 (checkForChanges)

**文件系统 Agent**（Claude/Codex/Kimi）：
```typescript
checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
  const changedIds: string[] = [];

  for (const session of cachedSessions) {
    const meta = this.sessionMetaMap.get(session.id);
    const stat = statSync(meta.sourcePath);
    
    // 通过文件修改时间判断是否变更
    if (stat.mtimeMs > sinceTimestamp) {
      changedIds.push(session.id);
    }
  }

  return {
    hasChanges: changedIds.length > 0,
    changedIds,
    timestamp: Date.now(),
  };
}
```

**数据库 Agent**（OpenCode/Cursor）：
```typescript
// 理论上可以通过 SQL 检测变更
// 当前未实现，需要补充

// 示例实现：
checkForChanges(sinceTimestamp: number): ChangeCheckResult {
  const result = db.query(`
    SELECT COUNT(*) as count, MAX(time_updated) as last_update 
    FROM session 
    WHERE time_updated > ?
  `, [sinceTimestamp]);
  
  return {
    hasChanges: result.count > 0,
    changedIds: [], // 可以通过 SQL 查询具体变更的 ID
    timestamp: Date.now(),
  };
}
```

#### 3.2.2 增量扫描 (incrementalScan)

只重新扫描变更的文件，而非全部：

```typescript
incrementalScan(cachedSessions: SessionHead[], changedIds: string[]): SessionHead[] {
  // 1. 创建缓存会话的 Map
  const sessionMap = new Map(cachedSessions.map(s => [s.id, s]));

  // 2. 只重新扫描变更的会话
  for (const file of this.listJsonlFiles()) {
    const sessionId = extractSessionId(file);
    
    if (changedIds.includes(sessionId)) {
      const head = this.parseSessionHead(file);
      sessionMap.set(head.id, head); // 更新缓存
    }
  }

  // 3. 检查新文件
  for (const file of this.listJsonlFiles()) {
    if (!sessionMap.has(sessionId)) {
      const head = this.parseSessionHead(file);
      sessionMap.set(head.id, head); // 添加新会话
    }
  }

  return Array.from(sessionMap.values());
}
```

### 3.3 缓存数据结构

当前缓存后端已经切换为 SQLite，位置是 `~/.cache/codesesh/codesesh.db`。

核心表：

- `cache_meta`
- `agent_cache`
- `cached_sessions`
- `session_documents`
- `session_documents_fts`

结构说明见 [sqlite-storage.md](./sqlite-storage.md)。

## 4. 数据一致性保证

### 4.1 会话详情加载

`getSessionData()` 依赖 `sessionMetaMap` 获取文件路径：

```typescript
getSessionData(sessionId: string): SessionData {
  // 从缓存恢复的 meta 中获取 sourcePath
  const meta = this.sessionMetaMap.get(sessionId);
  
  // 直接读取文件（不使用缓存，保证内容最新）
  const content = readFileSync(meta.sourcePath, "utf-8");
  
  // 解析并返回
  return parseMessages(content);
}
```

**关键设计**：
- 会话列表使用缓存（元数据）
- 会话详情实时读取文件（保证内容最新）
- 后台刷新只更新元数据，不影响正在查看的详情

### 4.2 缓存失效策略

| 触发条件 | 处理方式 |
|---------|---------|
| 缓存不存在 | 执行完整扫描 |
| 缓存过期 (7天) | 执行完整扫描 |
| 文件有变更 | 增量更新 |
| 文件被删除 | 从缓存中移除 |
| 新文件出现 | 添加到缓存 |

## 5. 性能数据

### 5.1 不同场景对比

| 场景 | 耗时 | 说明 |
|------|------|------|
| 首次启动（无缓存） | ~10.6s | 扫描所有文件 |
| 缓存启动（无变更） | ~14ms | 直接返回缓存 |
| 缓存启动（有变更） | ~14ms + ~200ms | 先返回缓存，后台增量更新 |
| 禁用缓存 | ~10.6s | 每次都完整扫描 |

### 5.2 并行加速效果

```
串行扫描：
Claude (1.1s) → Codex (3.9s) → Cursor (5.6s) = 10.6s

并行扫描：
Claude (1.1s) 
Codex (3.9s)    = ~5s (取决于最慢的 Agent)
Cursor (5.6s)   
```

## 6. 配置选项

### 6.1 CLI 参数

```bash
# 使用缓存（默认开启）
codesesh

# 禁用缓存
codesesh --no-cache

# 清除缓存后启动
codesesh --clear-cache

# 性能追踪
codesesh --trace
```

### 6.2 程序化配置

```typescript
const result = await scanSessions({
  useCache: true,      // 启用缓存
  smartRefresh: true,  // 启用智能刷新
  agents: ['claudecode', 'codex'], // 只扫描特定 Agent
  from: Date.now() - 7 * 24 * 60 * 60 * 1000, // 只扫描最近7天
});
```

## 7. 监控与调试

### 7.1 性能追踪

启用 `--trace` 查看详细耗时：

```
=== Performance Report ===

scanSessions: 14.60ms
  agent:claudecode: 3.89ms
    isAvailable: 0.27ms
    scan: 0ms (from cache)
  agent:codex: 2.52ms
    isAvailable: 0.15ms
    scan: 0ms (from cache)
```

### 7.2 缓存信息

```typescript
import { getCacheInfo } from "@codesesh/core";

const info = getCacheInfo();
console.log(info);
// { lastScanTime: 1776241234567, size: 124 }
```

## 8. 未来优化方向

### 8.1 会话级别并行

```typescript
// 当前：串行读取文件
for (const file of files) {
  await parseFile(file);
}

// 优化：并行读取
await Promise.all(files.map(file => parseFile(file)));
```

### 8.2 文件监听（Watch Mode）

```typescript
// 使用 fs.watch 实时监控文件变化
fs.watch(sessionDir, (eventType, filename) => {
  if (filename.endsWith('.jsonl')) {
    incrementalUpdate(filename);
  }
});
```

### 8.3 SQLite 存储深化

```typescript
// 当前已经使用 SQLite 统一持久化缓存和搜索索引
const db = new Database("~/.cache/codesesh/codesesh.db");

// 后续可以继续深化：
// - 将首次搜索的按需建索引改成后台预热
// - 将更多过滤条件前移到 SQLite 查询层
// - 让搜索索引覆盖更多结构化工具输出
```

## 9. 总结

CodeSesh 的扫描与缓存机制通过以下方式实现高性能：

1. **并行扫描**：所有 Agent 同时工作
2. **智能缓存**：先返回缓存，后台增量刷新
3. **变更检测**：通过文件修改时间精确识别变更
4. **数据一致性**：元数据缓存 + 内容实时读取

这种设计在保持极速启动（14ms）的同时，确保数据的新鲜度和一致性。
