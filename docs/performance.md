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
