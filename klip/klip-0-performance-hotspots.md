---
Author: "Codex"
Updated: 2026-05-17
Status: Complete
---

# klip-0-performance-hotspots

## 背景

- CodeSesh 的核心路径是本地 Agent 会话扫描、SQLite/FTS 缓存、HTTP API 聚合以及 React 会话浏览。
- 本次审计目标是找出会随着 session 数、message 数、file activity 数增长而放大的性能问题，不处理常数级样式或低影响重排。
- 代码库已有性能基准入口：`scripts/benchmark-performance.mjs` 和根脚本 `pnpm bench:perf`。
- 本文记录的是只读分析结论，用于后续分阶段实现和持续跟踪。

## 现状

- `packages/core/src/discovery/scanner.ts` 负责 agent 并行扫描，并通过 `filterSessions()` 做 `cwd` / time window 过滤。
- `packages/cli/src/live-scan.ts` 负责初始扫描、文件监听、增量刷新、缓存保存和 search index 同步。
- `packages/core/src/discovery/cache.ts` 同时承载 SQLite session cache、message 表、file activity 表和 `session_documents_fts` 搜索索引。
- `packages/cli/src/api/handlers.ts` 在内存快照上计算 dashboard、sessions、projects，并调用 core cache 层做搜索和 file activity 查询。
- `apps/web/src/App.tsx` 和 `apps/web/src/components/SessionDetail.tsx` 在前端维护路由状态、列表派生数据、会话详情 TOC 和消息渲染。

## 目标

- 把已发现的性能问题按影响和落地风险排序。
- 为每个问题记录代码位置、当前复杂度、建议方案、优化后复杂度和验证方式。
- 提供 task checklist，后续实现时可以逐项更新状态。
- 保持外部行为不变：session 顺序、过滤语义、搜索结果、bookmark、TOC、file activity 语义都不能因优化改变。

## 非目标

- 本文不直接修改实现代码。
- 本文不重新设计 CodeSesh 的产品信息架构。
- 本文不引入新的缓存后端或替换 SQLite。
- 本文不处理扫描器误报中的测试文件或 `.claude/worktrees` 代码。

## 发现与方案

### P1（性能 / 启动与 API 过滤）

#### 1. `cwd` 过滤每个 session 重复计算 project identity

位置：
- `packages/core/src/discovery/scanner.ts`（`isProjectScopeMatch()` / `filterSessions()`）
- `packages/cli/src/api/handlers.ts`（`matchesProjectScope()` / `handleGetSessions()`）
- `packages/core/src/projects/identity.ts`（`computeIdentity()`）

现象/风险：
- `isProjectScopeMatch()` 和 `matchesProjectScope()` 在 session `filter()` 内调用 `computeIdentity(cwd, realFs)`。
- `computeIdentity()` 会向上查找 `.git` / manifest，并可能执行 `git config --get remote.origin.url`。
- 当 session 数为 `n` 时，一个固定 `cwd` 会被重复解析 `n` 次。

当前复杂度：
- `O(n * (path_depth + git/fs))`。

建议方案：
- 在进入 session 循环前计算一次 query identity。
- 预先归一化 `cwd.toLowerCase()`，循环内只比较 `session.project_identity?.key` 和 path scope。
- `scanner.ts` 和 `handlers.ts` 应复用同一套 scope matcher，避免语义分叉。

优化后复杂度：
- `O(path_depth + git/fs + n)`。

风险：
- 低。主要风险是 `scanner.ts` 的双向 path scope 语义和 `handlers.ts` 当前 `directory.includes(cwd)` 语义不完全相同。

验收标准：
- `cwd` 查询结果与现有行为一致，覆盖 exact match、query 是 session parent、session 是 query parent。
- `project_identity.key` 命中时不再触发每条 session 的 `computeIdentity()`。
- 增加 focused test 覆盖 core filter 和 API sessions route。

#### 2. Dashboard 聚合重复遍历，并为 top 10 做全量排序

位置：
- `packages/cli/src/api/handlers.ts`（`handleGetDashboard()`）

现象/风险：
- `scopedSessions`、`windowed`、`scopedByAgent`、`agentInfo`、`perAgent` 多次过滤同一批 sessions。
- `recentSessions` 对整个窗口做 `.sort()` 后只取 10 条。
- session 数大时 dashboard 请求会重复消耗 CPU。

当前复杂度：
- 多次 `O(n)`，加 `O(w log w)` recent sort；`w` 是 dashboard window 内 session 数。

建议方案：
- 单 pass 计算 totals、perAgent、daily buckets、model distribution。
- recent sessions 使用固定容量 top-k，或复用已经按 activity 排序的 store snapshot。
- 保留当前 dashboard response shape。

优化后复杂度：
- `O(n + model_entries)`；recent top 10 为 `O(w)`。

风险：
- 低到中。主要风险是 per-agent totals、window 边界和 project scope 过滤出现计数偏差。

验收标准：
- `handleGetDashboard()` route tests 覆盖 root、agent scope、project scope。
- 同一 fixture 下优化前后 JSON 深比较一致，允许排序字段按现有语义保持一致。

### P1（性能 / Live Refresh 与索引）

#### 3. 单文件 refresh 仍执行全量 agent cache 保存与 search index diff

位置：
- `packages/cli/src/live-scan.ts`（`runRefresh()`）
- `packages/core/src/discovery/cache.ts`（`saveCachedSessions()`）
- `packages/core/src/discovery/cache.ts`（`syncSessionSearchIndex()`）

现象/风险：
- `runRefresh()` 即使只收到一个文件变化，也把完整 `nextSessions` 传给 `saveCachedSessions()` 和 `syncSessionSearchIndex()`。
- `saveCachedSessions()` 会遍历该 agent 全量 sessions 并 upsert。
- `syncSessionSearchIndex()` 会读取现有 indexed rows 和 message counts，再对全量 sessions 求 `toUpsert`。

当前复杂度：
- 每次 refresh 约 `O(n + indexed_messages)`，再叠加变更 session 的全文读取与解析。

建议方案：
- `checkForChanges()` / `incrementalScan()` 输出 changed/new/removed session ids。
- cache 层增加增量接口：按 changed ids upsert，按 removed ids delete。
- search index 层支持 changed ids 入口；bulk 事件仍走现有全量路径。

优化后复杂度：
- 普通 refresh：`O(c + changed_messages + removed)`。
- bulk refresh：保留 `O(n)`。

风险：
- 中。涉及 SQLite 多表一致性：`sessions`、`cached_sessions`、`project_sessions`、`session_documents`、`messages`、`session_file_activity`。

验收标准：
- 增量更新后 `loadCachedSessions()` 与全量保存结果一致。
- 删除 session 时对应 FTS、messages、file activity、project_sessions 均清理。
- `pnpm bench:perf -- --iterations 3` 的 refresh 路径应下降，冷启动不回退。

#### 4. 搜索结果 matchType/snippet 存在 N+1 messages 查询

位置：
- `packages/core/src/discovery/cache.ts`（`searchSessions()` / `rowsToSearchResults()` / `resolveSearchMatch()`）

现象/风险：
- FTS 先返回 session rows。
- `rowsToSearchResults()` 对每条结果调用 `resolveSearchMatch()`。
- `resolveSearchMatch()` 若 title 不匹配，会再查询该 session 全部 messages，并在 JS 中逐条做 text term 匹配。

当前复杂度：
- `O(r * avg_messages_per_session)`；默认 `r <= 50`，但大 session 会拖慢搜索。

建议方案：
- 建立 message-level FTS 表，直接返回命中的 message、role、mode、tool metadata。
- 或在 session index 中保存首个匹配位置和轻量 match metadata，减少二次扫描。
- 保留现有 `SearchResult` response shape。

优化后复杂度：
- 接近 `O(r)`，消息命中定位交给 SQLite FTS。

风险：
- 中。snippet 高亮、`matchType` 分类、tool output 判定都属于用户可见行为。

验收标准：
- 搜索 title、user message、assistant reply、tool output 的 `matchType` 与现有 fixture 一致。
- OR / quoted query / qualifier 查询行为不变。
- 搜索 route 增加大 session fixture，验证不会为每条结果全量加载 messages。

#### 5. File activity 查询不利于索引

位置：
- `packages/core/src/discovery/cache.ts`（`listFileActivity()` / `searchFileActivitySessions()`）

现象/风险：
- SQL 使用大量 `(? IS NULL OR ...)` 和 `LOWER(column) LIKE '%...%'`。
- 现有 `idx_file_activity_project_latest`、`idx_file_activity_path`、`idx_file_activity_kind` 在这些条件下不能稳定发挥作用。
- dashboard recent file activity 和 file path search 都可能退化为扫描 `session_file_activity`。

当前复杂度：
- 常见查询接近 `O(file_activity_rows)`。

建议方案：
- 按实际参数动态拼接 WHERE，避免 `OR ? IS NULL` 破坏查询计划。
- 增加 `latest_time`、`agent_name/latest_time` 组合索引。
- 路径搜索如果要支持 contains，可以后续单独评估 normalized lowercase column 或 path FTS。

优化后复杂度：
- recent 查询 `O(log n + limit)`。
- path contains 搜索仍取决于专用索引/FTS 方案。

风险：
- 中。涉及 SQLite migration 和查询计划，需要避免改变 file activity 过滤语义。

验收标准：
- `EXPLAIN QUERY PLAN` 验证 recent file activity 使用 latest_time 相关索引。
- API tests 覆盖 agent、sessionId、projectKey、cwd、path、kind、from/to 组合。

### P1（性能 / 前端渲染）

#### 6. SessionDetail 重复构建 message blocks，并一次性渲染全部消息

位置：
- `apps/web/src/components/SessionDetail.tsx`（`SessionDetail()`）
- `apps/web/src/components/session-detail/toc.ts`（`buildSessionDetailToc()` / `filterSessionMessages()`）
- `apps/web/src/components/session-detail/blocks.ts`（`buildMessageBlocks()`）

现象/风险：
- `visibleMessages`、`buildFileChangeSummary()`、`buildSessionDetailToc()`、`filterSessionMessages()` 分别遍历 messages/parts。
- `buildSessionDetailToc()` 和 `filterSessionMessages()` 都调用 `buildMessageBlocks()`。
- 渲染阶段对 `filteredMessages` 全量 `.map()`，大 session 会产生大量 DOM。

当前复杂度：
- 派生数据多次 `O(messages * parts)`。
- DOM 渲染 `O(visible_messages)`。

建议方案：
- 先生成一次 `MessageDisplayModel`，缓存 `blocks`、visibility、file activity anchors、toc contribution。
- TOC、filter、render 复用同一批 blocks。
- 长 session 引入 virtualization；先限定在 message list，不改变 message item 内部结构。

优化后复杂度：
- 派生数据单次 `O(messages * parts)`。
- DOM 渲染约 `O(viewport_items)`。

风险：
- 中。anchors、TOC filter、highlight、scrollIntoView 都可能受影响。

验收标准：
- 大 session 页面打开时间下降。
- TOC counts、tool filters、file summary anchors、highlight query 行为保持一致。
- 用 Playwright 覆盖详情页打开、filter toggle、bookmark、scroll/focus。

#### 7. App 级 session 派生数据重复过滤和查找

位置：
- `apps/web/src/App.tsx`（`sessionsByAgent`、`projectSidebarSessions`、`recentSearchResults`、`openedSessionHead`、keyboard navigation）

现象/风险：
- `sessionsByAgent`、`projectSidebarSessions`、`activeProjectSessions`、agent landing sessions、recent search results 都从全量 `sessions` 派生。
- keyboard navigation 和 sidebar select 使用 `find()` / `findIndex()`。
- 单次成本不大，但全局状态变化时会在主 App render 路径重复执行。

当前复杂度：
- 多个 `O(n)` 派生；局部交互 `O(sidebar_sessions)`。

建议方案：
- 在 App 内建立一次 session indexes：`byAgent`、`byProjectIdentityKey`、`byId`、`sidebarIndexById`。
- 保留当前 API response，不把这个问题上升为后端改造。

优化后复杂度：
- 派生 index 一次 `O(n)`；后续查询 `O(1)` 或按目标分组大小遍历。

风险：
- 低到中。主要风险是 active project / selected project / agent filter 的顺序稳定性。

验收标准：
- sidebar 顺序、project landing、missing-session fallback、keyboard j/k/g/G/Enter 行为一致。
- `apps/web` 现有 tests 通过，补充 navigation/index 行为测试。

## 建议落地顺序

1. 先处理 `cwd` identity 重复计算：改动小，收益确定，测试范围可控。
2. 再处理 dashboard 单 pass 聚合：可用 JSON fixture 做前后对照，收益直接体现在 API 请求。
3. 处理 live refresh 增量 cache/index：收益最大，但必须先补齐一致性测试。
4. 处理 search match N+1：需要设计 message-level FTS 或 metadata 方案，避免破坏搜索语义。
5. 处理 SessionDetail display model：先去重 block 构建，再评估 virtualization。
6. 最后处理 file activity 查询计划和 App indexes：根据 bench / profiler 数据决定优先级。

## 持续跟进 Checklist

- [x] P1-1：重构 `cwd` scope matcher，预计算 query identity，并补 core/API tests。
- [x] P1-2：将 `handleGetDashboard()` 改为单 pass 聚合，并保持 response shape 不变。
- [x] P1-3：为 `LiveScanStore.runRefresh()` 设计 changed/new/removed ids 传递契约。
- [x] P1-4：为 cache 层增加增量 upsert/delete，并验证与全量保存结果一致。
- [x] P1-5：为 `syncSessionSearchIndex()` 增加 changed ids 路径，bulk 仍保留全量 rebuild。
- [x] P1-6：评估并实现 message-level FTS，消除搜索结果 N+1 message scan。
- [x] P1-7：重写 `listFileActivity()` 动态 WHERE，并用 `EXPLAIN QUERY PLAN` 验证索引。
- [x] P1-8：构建 `SessionDetail` display model，复用 `MessageBlock[]`。
- [x] P1-9：评估详情页 message virtualization，确认 anchors 和 keyboard/scroll 行为可保留。
- [x] P1-10：在 `App.tsx` 建立 session indexes，减少重复 `filter()` / `find()`。
- [x] 验证：每项优化至少运行相关 package tests。
- [x] 验证：完成 P1-2 / P1-3 / P1-6 / P1-8 后运行 `pnpm bench:perf` 记录前后结果。

## 实现记录

- 2026-05-20：完成 P1-2。`handleGetDashboard()` 改为在一次 session 扫描中完成 totals、per-agent、daily buckets、token buckets、model distribution 和 recent top 10 聚合；recent top 10 使用固定容量候选集，避免对窗口内全量 session 排序。验证：`pnpm --filter codesesh test`、`pnpm --filter codesesh lint`、`pnpm --filter codesesh format:check`、`pnpm --filter codesesh build`、`git diff --check`、`pnpm bench:perf -- --iterations 1`（236 sessions；dashboard visible 11956ms；detail 139ms）。
- 2026-05-20：完成 P1-6。新增 `messages_fts` message-level FTS 表和 `messages` 触发器，schema 升级到 v9；`searchSessions()` 保留 session-level FTS 排序，但对返回候选结果只做一次批量 message FTS 查询来解析 `matchType` / `snippet`，移除每条结果单独加载全量 messages 的 N+1 路径。验证：`pnpm --filter @codesesh/core exec vitest run src/discovery/__tests__/cache.test.ts`、`pnpm --filter @codesesh/core exec vitest run src/discovery/__tests__/migration-smoke.test.ts`、`pnpm --filter @codesesh/core test`、`pnpm --filter @codesesh/core lint`、`pnpm --filter @codesesh/core format:check`、`pnpm --filter @codesesh/core build`、`git diff --check`、`pnpm bench:perf -- --iterations 1`（242 sessions；dashboard visible 5081ms；detail 183ms）。
- 2026-05-20：完成 P1-8 / P1-9。`SessionDetail` 先构建一次 `MessageDisplayModel[]`，TOC、filter、render 和 file tracker 复用同一批 `MessageBlock[]`；长会话消息列表改为绑定实际滚动父级的窗口化渲染，并在 file tracker 跳转远端 tool anchor 时强制挂载目标 message，保持锚点可达。验证：`pnpm --filter @codesesh/web test`、`pnpm --filter @codesesh/web lint`、`pnpm --filter @codesesh/web format:check`、`pnpm --filter @codesesh/web exec tsc -b`、`pnpm --filter codesesh build`；Browser 验证 2500-message 会话初屏只挂载 8 个 article，滚动后约 11 个 article，File Tracker `Next` 锚点可跳到远端 tool 区域且无新增 console error；`pnpm bench:perf -- --iterations 1`（247 sessions；dashboard visible 14478ms；detail 230ms）。
- 2026-05-20：完成 P1-10。`App.tsx` 新增 session indexes 复用路径：route session head、agent sidebar、project sidebar、landing sessions、project options 和 recent search 都从一次 `buildSessionIndexes()` 派生；sidebar keyboard navigation 和 tree select 改为使用 `buildSidebarSessionLookup()`，移除交互路径上的 `findIndex()` / `find()`。补充 `session-indexes.test.ts` 覆盖 route/agent/project/activity 顺序和 sidebar first-match lookup。验证：`pnpm --filter @codesesh/web test`、`pnpm --filter @codesesh/web lint`、`pnpm --filter @codesesh/web format:check`、`pnpm --filter @codesesh/web exec tsc -b`、`pnpm --filter @codesesh/web build`、`git diff --check`、`pnpm bench:perf -- --iterations 1`（249 sessions；dashboard visible 4879ms；detail 200ms）。

## 测试矩阵

| 场景 | 测试类型 | 覆盖要求 / 优先级 |
|---|---|---|
| `cwd` scope matcher | unit / route test | exact、parent/child path、project identity key、empty directory |
| Dashboard 聚合 | route test | root、agent scope、project scope、date window、top recent |
| Live refresh 增量缓存 | unit / integration | changed、new、removed、bulk、startup window |
| Search match metadata | unit / integration | title、user、assistant、tool、OR、quoted query、qualifiers |
| File activity 查询 | unit / query plan | agent、sessionId、projectKey、cwd、path、kind、from/to |
| SessionDetail display model | component / browser | TOC counts、tool filter、file anchors、highlight、empty filtered state |
| App session indexes | component / browser | sidebar order、project landing、missing session、keyboard navigation |

## 验收标准

- 所有 checklist 项都有 owner 或明确状态。
- 每个已实现优化都记录测试命令和 benchmark 结果。
- 用户可见输出保持兼容：API response shape、搜索结果、dashboard 数字、sidebar 顺序、详情页交互不变。
- 性能收益以 `pnpm bench:perf`、route-level timing 或 React profiler 数据记录，不只依赖静态推断。

## 本次代码复核证据

- 已运行 complexity scanner，分别扫描 `packages/core`、`packages/cli`、`apps/web`。
- 已人工复核 scanner 高噪声区域，排除测试文件和 `.claude/worktrees`。
- 已确认根脚本存在 `pnpm test`、`pnpm build`、`pnpm lint`、`pnpm bench:perf`。
- 原始审计未运行测试或 benchmark；已实现项的验证命令记录在「实现记录」。

## 关键参考位置

- `packages/core/src/discovery/scanner.ts`
- `packages/core/src/discovery/cache.ts`
- `packages/core/src/projects/identity.ts`
- `packages/cli/src/live-scan.ts`
- `packages/cli/src/api/handlers.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/components/SessionDetail.tsx`
- `apps/web/src/components/session-detail/toc.ts`
- `apps/web/src/components/session-detail/blocks.ts`
- `scripts/benchmark-performance.mjs`
