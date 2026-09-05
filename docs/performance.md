# 性能保障

性能回归分三层防守，各自承担不同性质的信号。新增性能修复时，应当明确它属于哪一层。

## 1. 结构性 gate（PR CI，确定性）

与被保护的代码放在一起的普通测试，断言的是**结构**而不是耗时，因此不受机器状态影响。
当前已有的：

| 断言 | 位置 |
|------|------|
| 一次 Cursor 扫描只发一条 bubble 查询 | `packages/core/src/agents/__tests__/cursor-scan-shape.test.ts` |
| 一次 Session Detail 只发一条 part 查询 | `packages/core/src/agents/__tests__/opencode-sqlite.test.ts` |
| 文件活动搜索的 limit 作用于 Session | `packages/core/src/discovery/cache/__tests__/search-integration.test.ts` |
| 关键查询走预期索引（`EXPLAIN QUERY PLAN`） | 同上两处 |
| 仅会话头元数据变化时复用已物化消息 | `packages/core/src/discovery/cache/__tests__/search-index-writer.test.ts` |
| 已有索引的批量会话更新不重建无关历史全文 | 同上 |
| 首屏 JS gzip 预算与延迟依赖 | `apps/web/tests/initial-bundle.test.ts` |
| Session Detail 缓存基数上界 | `apps/web/src/lib/session-detail-cache.test.ts` |
| 一帧测量只产生一次 commit | `apps/web/src/components/session-detail/message-list.test.tsx` |

新增此类 gate 时优先选择可计数的事实（查询次数、字节数、缓存条目数），而不是毫秒阈值。

## 2. 增长斜率检查（PR CI）

```bash
pnpm perf:check
```

`scripts/perf-scale.mjs` 对若干算法在两个规模下测量**每项成本**，断言其不随规模显著上升。
单点毫秒数无法区分 `O(N)` 与 `O(N²)`，斜率可以。容差刻意宽松（×2.5），只用于捕捉数量级变化；
把 CS-145 修复前的二次分配器放回去，该检查会稳定报出 ×4 以上并失败（由
`scripts/perf-scale.test.mjs` 固化）。

## 3. 端到端 wall-clock（本地 / nightly，不进 PR CI）

```bash
pnpm bench:perf            # 真实浏览器冷启动与导航
pnpm bench:session-index   # Session index 构建
pnpm bench:message-search  # 候选消息扫描与 trigram FTS5 的写入/查询/体积权衡
```

这些基准读取开发者本机的会话数据、或在真实浏览器中测量墙钟时间，数值随机器与历史数据变化。
它们用于观察和调查，不作为必需检查——把这种信号变成 required check 只会制造 flaky。
`bench:session-index` 仍带一个宽松的比值预算，用于捕捉「规范路径反而更慢」这类明确错误。
`bench:message-search` 固定测量 50 个候选会话各 2,000 条消息、且所有查询词分布在不同
消息中的最坏情况；可通过 `MESSAGE_SEARCH_BENCH_SESSIONS`、
`MESSAGE_SEARCH_BENCH_MESSAGES` 和 `MESSAGE_SEARCH_BENCH_ITERATIONS` 调整规模。

## 模型价格查找基准

```bash
node scripts/benchmark-pricing.mjs
```

使用当前源码，在独立进程中构造 1,000、10,000、20,000 条模型价格，分别测量精确命中、
型号变体和未知型号。每项先预热 100 次，再取 5 组各 1,000 次查询的中位耗时；不请求网络，
不写入用户价格缓存。此微基准不作为 CI 时间门槛，也不代表整次扫描的提速比例。

2026-09-05，macOS / Node 24.20.0，本地对照 `6d8cda3`：

| 价格条目 | 查询 | 修改前（ms） | 修改后（ms） |
|---|---|---:|---:|
| 10,000 | 精确型号 | 0.086 | 0.083 |
| 10,000 | 型号变体 | 1,664.575 | 1.499 |
| 10,000 | 未知型号 | 5,558.814 | 2.332 |
| 20,000 | 型号变体 | 3,354.288 | 1.427 |
| 20,000 | 未知型号 | 10,988.700 | 2.261 |

旧实现为每个候选型号遍历价格表；新实现沿型号的 `-`、`@` 边界从长到短直接查表。
设价格条目数为 M、型号长度为 L、候选数量为固定常数，旧实现最坏约 O(M × L)，
新实现最多执行 O(L) 次 Map 查询，计入子串构造和哈希后最坏 O(L²)，不再随 M 线性增长。
不增加持久索引或结果缓存，继续即时读取当前价格版本。

## 会话增量关系计算基准

```bash
pnpm --filter @codesesh/core build
node scripts/benchmark-session-projection.mjs
```

构造深链和宽树两种结构，一次更新除根节点外的全部会话。预热一次后，取三次关系计算的
中位耗时，并验证根节点仍被作为关联会话返回。数据全部为内存中的合成数据。

2026-09-05，macOS / Node 24.20.0，对照 `457bce9`：

| 结构 | 会话数 | 修改前（ms） | 修改后（ms） |
|---|---:|---:|---:|
| 深链 | 500 | 23.730 | 1.070 |
| 深链 | 2,000 | 385.725 | 3.665 |
| 深链 | 8,000 | 7,203.293 | 16.568 |
| 宽树 | 8,000 | 12.823 | 12.256 |

旧实现为每个变化节点重新遍历祖先，最坏 O(N²)。现在同一张图内共享祖先访问集合，
每条父边最多向上访问一次，整体关系计算变为 O(N)，空间仍为 O(N)。祖先访问集合与
后代访问集合保持独立，避免因已经收集某节点的后代而遗漏其祖先。前后快照使用各自的集合。

深链是压力场景，不代表常见 Agent 会话的层级深度，也不代表整个扫描流程的耗时。

## 会话时间窗口过滤基准

```bash
pnpm --filter @codesesh/core build
node scripts/benchmark-session-window.mjs
```

构造每组一个根节点、四个子会话的合成历史，测量无边界、前端 All time 使用的
`from: 0`、以及筛掉一半根节点的范围。每项预热一次，取五组各二十次调用的中位耗时。

2026-09-05，macOS / Node 24.20.0，对照 `e90f15a`：

| 会话数 | 时间范围 | 修改前（ms） | 修改后（ms） |
|---|---|---:|---:|
| 10,000 | All time (`from: 0`) | 168.341 | 0.486 |
| 50,000 | 无边界 | 923.383 | < 0.01 |
| 50,000 | All time (`from: 0`) | 1,188.501 | 4.983 |
| 50,000 | 筛掉一半根节点 | 1,137.588 | 1,134.142 |

旧实现的默认参数在检查边界前就构建完整会话树。现在无边界时以 O(1) 返回原数组；
所有会话均在范围内时，仅以 O(N) 检查时间并复制数组，省去建树与统计汇总，但仍保持
有边界调用返回新数组的行为。需要实际筛选时继续使用原有树规则，保留命中父节点的全部
子会话；调用方显式提供树时，也继续使用该树。All time 优化主要减少分配和计算常数，
其渐进复杂度仍为 O(N)。上述数据仅衡量过滤函数，不代表页面或扫描整体耗时。
