# CodeSesh 扫描架构

<!-- repo-fact:agent-source-kinds:start -->
```
┌────────────────────────────────────────────────────────────────┐
│                         CLI Entry                              │
│                    packages/cli/src/index.ts                   │
└────────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                    Core Scanner Module                         │
│              packages/core/src/discovery/scanner.ts            │
│                                                                │
│   ┌─────────────────┐     ┌──────────────────────────────┐    │
│   │  scanSessions() │────▶│   Agent 并行扫描 (Promise.all)│    │
│   └─────────────────┘     └──────────────────────────────┘    │
│                                      │                         │
│                                      ▼                         │
│                    ┌─────────────────────────┐                │
│                    │    scanAgentSmart()     │                │
│                    │    智能扫描策略          │                │
│                    └─────────────────────────┘                │
│                             │                                  │
│              ┌──────────────┼──────────────┐                  │
│              ▼              ▼              ▼                  │
│        ┌─────────┐   ┌──────────┐   ┌──────────┐            │
│        │  检查缓存 │   │ 完整扫描  │   │ 增量刷新  │            │
│        │         │   │         │   │         │            │
│        │ 命中?    │   │ 无缓存   │   │ 检测变更  │            │
│        └────┬────┘   └──────────┘   └─────────┘            │
│             ▼ Yes                                           │
│        ┌─────────┐                                          │
│        │ 立即返回 │                                          │
│        └─────────┘                                          │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                        Agent Registry                          │
│              packages/core/src/agents/register.ts              │
│                                                                │
│  文件系统: Claude Code · Codex · DSH · Grok · Kimi-Cli · Kimi-Code · Pi │
│  SQLite:  OpenCode · Cursor · ZCode                            │
│  扩展方式: 实现适配器 + 在 register.ts 声明完整能力             │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                          Cache Layer                           │
│             packages/core/src/discovery/cache/*.ts              │
│                                                                │
│   存储位置: ~/.cache/codesesh/codesesh.db                     │
│   存储内容: session heads + materialized details + FTS        │
└────────────────────────────────────────────────────────────────┘

详细表结构和数据流见 [sqlite-storage.md](./sqlite-storage.md)。
```
<!-- repo-fact:agent-source-kinds:end -->

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

1. **并行扫描**: 所有 Agent 同时工作
2. **快速返回**: 缓存命中时优先返回缓存数据
3. **智能刷新**: 后台检测变更，增量更新
4. **数据一致**: 详情优先读取结构化快照，源指纹失效时回源解析

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
