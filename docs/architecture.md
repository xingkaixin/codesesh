# CodeSesh 运行时架构

CodeSesh 有两条启动路径。默认 Web 模式是持续运行的缓存恢复、后台核对与事件刷新；
`--json` 是扫描完成后退出的一次性路径。两者共享 Agent 注册表、扫描原语和 SQLite，
但生命周期与发布时机不同。

## 默认 Web 模式

```text
CLI Entry (packages/cli/src/index.ts)
  -> LiveScanStore.initialize()
       -> scanSessions(cacheOnly: true) 从 SQLite 恢复初始快照
       -> SessionWatcher 开始监听已注册 Agent 的数据根目录
  -> 启动 Hono HTTP API / SSE
  -> LiveScanStore.startBackgroundRefresh()
       -> AgentSyncEngine 按 Agent 串行化 refresh 与 backfill
            -> scan-refresh worker 核对并解析真实数据源
            -> search-index worker 提交 sessions、details 与 FTS
            -> LiveSessionIndex 发布新的不可变内存快照
            -> SSE 通知 Web UI
       -> 后续文件事件继续触发对应 Agent 的 refresh
```

初始 SQLite 快照可以立即被 API 读取。后台结果只有在对应持久化事务成功后才进入内存
快照，因此客户端不会先看到无法从 SQLite 重建的状态。详细的变更检测、回填、失败保留
和发布规则见 [scanning-and-caching.md](./scanning-and-caching.md)。

## 一次性 JSON 模式

```text
CLI Entry (packages/cli/src/index.ts --json)
  -> LiveScanStore.initialize()
       -> scanSessions(cacheOnly: false) 扫描所选 Agent
       -> 同步初始搜索索引
  -> 应用 --days / --from / --to 输出窗口
  -> 输出 JSON 并退出
```

这条路径关闭文件监听，也不启动后台 refresh。输出窗口只裁剪最终列表，不限制启动扫描
范围；扫描失败会写入诊断并设置非零退出码。

## 共享模块

| 模块 | 职责 |
|------|------|
| `packages/core/src/discovery/scanner.ts` | 初始快照恢复与一次性扫描编排 |
| `packages/core/src/contract/agent-catalog.ts` | Agent 公开身份与存储类型声明 |
| `packages/core/src/agents/base.ts` | Agent 原语与显式 Session Source Access 能力 |
| `packages/core/src/agents/register.ts` | Agent 工厂与数据根目录注册 |
| `packages/core/src/agents/registry.ts` | 注册表存储与 Catalog/运行时能力一致性校验 |
| `packages/cli/src/live-scan.ts` | 运行中快照、订阅和生命周期入口 |
| `packages/cli/src/agent-sync-engine.ts` | 持续 refresh、backfill、持久化后发布 |
| `packages/cli/src/session-watcher.ts` | 文件事件监听、稳定性等待与归并 |
| `packages/cli/src/scan-refresh-worker.ts` | 数据源扫描与解析 worker |
| `packages/cli/src/search-index-worker.ts` | SQLite 会话、详情和 FTS 写入 worker |

<!-- repo-fact:agent-source-kinds:start -->
- 文件系统: Claude Code · Codex · DSH · Grok · Kimi-Cli · Kimi-Code · Pi
- SQLite: OpenCode · Cursor · ZCode
<!-- repo-fact:agent-source-kinds:end -->

SQLite 存储在 `~/.cache/codesesh/codesesh.db`，包含 session heads、materialized details
和 FTS。表结构与事务边界见 [sqlite-storage.md](./sqlite-storage.md)。

## 性能说明

以下是 v0.9 前的历史数据，采集硬件、commit 和样本规模均未记录，且早于 CS-43 的 SessionIndex 集中化，仅用于理解架构演进，不代表当前性能基线。

```
┌────────────────┬──────────┬────────────┬─────────────┐
│     场景       │  首次    │ 缓存命中   │  后台刷新   │
├────────────────┼──────────┼────────────┼─────────────┤
│ 串行扫描       │  10.6s   │  10.6s     │    N/A      │
│ 并行扫描       │   5.0s   │   5.0s     │    N/A      │
│ 智能缓存       │  10.6s   │  14ms      │  14ms+200ms │
└────────────────┴──────────┴────────────┴─────────────┘
```

当前版本应使用仓库内的端到端基准脚本重新测量；结果取决于本机会话规模、缓存状态与硬件：

```bash
pnpm bench:perf -- --iterations 3
```

## 关键特性

1. **快速启动**：Web 模式优先发布 SQLite 中已持久化的快照
2. **隔离刷新**：不同 Agent 可并行推进，同一 Agent 的 refresh 与 backfill 保持串行
3. **提交后发布**：SQLite 与搜索索引写入成功后才更新内存快照和 SSE
4. **持续核对**：后台初始化、全历史 backfill 与文件事件共同维持新鲜度
5. **详情一致**：详情优先读取结构化快照，源指纹失效时回源解析

## 使用方法

```bash
# 默认模式（智能缓存）
codesesh

# 禁用缓存
codesesh --no-cache

# 清除缓存
codesesh --clear-cache

# 性能追踪
codesesh --trace
```

## 依赖决策

- **TypeScript preview 编译器别名**：workspace 内 `"typescript"` 别名指向 TS 6 preview
  （`@typescript/typescript6`，供 tsup d.ts 发射与 Astro 等仍依赖 `typescript` API 的工具），
  `"@typescript/native"` 指向 TS 7 原生编译器（日常 `tsc` 类型检查，速度显著更快）。
  两者并存是刻意选择：拿到 TS 7 的编译速度，同时不阻塞尚未适配 TS 7 API 的生态工具；
  待生态跟进 TS 7 API 后收敛为单一依赖。
- **highlight.js 10.x（EOL）经 react-syntax-highlighter 进入依赖图**：代码只 import
  `react-syntax-highlighter/dist/esm/prism-light`（Prism/refractor 路径），highlight.js
  已验证被完整 tree-shake（产物中仅剩 `"hljs"` 类名字符串字面量），不进 bundle、不可达。
  接受其留在 node_modules；若未来 `pnpm audit` 对其报可达告警，再评估换用 Prism-only 方案。
