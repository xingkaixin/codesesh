# Changelog

## [1.0.2] - 2026-08-14

本版本新增 DeepSeek Harness (DSH)，成为第十个受支持的 Agent。

### 新功能

- 在 macOS、Linux 与 Windows 上从 `DSH_HOME/sessions`（默认 `~/.dsh`）发现并读取 DeepSeek Harness 会话，逐帧解码其多帧 Zstandard 日志且不写入原始文件；读取压缩日志需要 Node `^22.19.0 || >=24.0.0` 提供的原生 Zstandard 解码器。 (#377)
- 注册 DSH 及其工具展示策略，编辑卡片优先使用 DSH 随工具结果附带的上下文 hunk；因其启动器接受 profile 相关参数，未声明 resume 命令。 (#377)

### 文档

- 在 README、架构文档与产品落地页中列出 DSH。 (#377)

### Changelog Detail

- #377 feat: support DeepSeek Harness session discovery @xingkaixin

## [1.0.1] - 2026-08-13

本版本强化扫描、缓存与同步链路在部分失败或中断场景下的正确性，修补远程访问与浏览器安全缺口，消除大规模历史下的启动与渲染瓶颈，并重新设计 Dashboard 图表。

### 新功能

- 基于统一的方块画布图元重新设计 Dashboard 图表：每日用量以 Token 堆叠柱加成本面积呈现，Agent 使用柱状图，模型成本使用环形图；移除与项目页重复的项目排行卡片。 (#303)
- 新增基于游标的会话快照分页 API，并在 Web UI 中按页渐进加载。 (#355)
- 实时会话详情改为增量流式更新，不再整体刷新会话。 (#357)

### 安全

- 新增 Content-Security-Policy 及其他浏览器安全响应头，并将主题引导脚本移出内联脚本。 (#345)
- 环回代理强制要求认证，校验环回请求来源，并在远程与环回传输上拒绝跨站写入。 (#279, #293, #308, #315, #344)
- 扫描时不再跟随符号链接的会话文件与 Cursor 链接工作区目录。 (#343)
- 收敛 CLI 输出中的凭据与路径暴露。 (#353)
- 强化 CI 供应链管控，并在发布前校验已发布的 npm 制品。 (#288, #347)

### 性能

- 将孤儿缓存清理延后到索引写入阶段，消除启动延迟。 (#371)
- 跨请求复用 SQLite 连接、刷新缓存快照、搜索索引 Worker 与分析用会话树。 (#354, #356, #360, #361)
- 从缓存直接推导恢复后的会话顺序，并在扫描间保留 Claude Code 子会话索引。 (#362, #363)
- 限制近期会话搜索、单会话消息 FTS 查询、OpenCode 关联会话查询、Cursor composer 扫描缓存以及实时链路中的扫描状态推送规模。 (#284, #285, #286, #299, #359)
- 通过缓存转录渲染结果与节流实时聚合刷新，稳定 Web 渲染热点路径。 (#357, #358)
- 将大规模搜索索引积压按持久化分块预处理，并在全量重扫中复用缓存的 smart tag。 (#305, #326)

### 问题修复

- 将全历史维护与发布解耦，后台索引不再阻塞可见会话状态。 (#374)
- 在部分、失败或中断的扫描下保持已发布状态正确：仅发布持久化状态、原子提交、保留部分快照事实与失败扫描结果，以及保留扫描窗口外的缓存。 (#275, #277, #294, #295, #296, #334)
- 源解析失败时保留会话，并终止启动重扫与 Codex 源失败的永久循环。 (#278, #324, #326)
- 会话详情发布改为原子操作，并为持久化详情与派生投影加上版本，使过期缓存可自愈。 (#276, #282, #290, #333)
- 修正成本与定价：跨 Agent 修复缺失定价、统一 Worker 定价代际、保留过期定价缓存、定价到达后重新解析缓存会话头、将 Codex 溢出用量归属到模型，并在搜索中使用包含子会话的成本。 (#304, #307, #316, #325, #327, #330, #337)
- 修复 Cursor、Codex、Claude Code、Kimi、Kimi-Code、Grok、Pi 与 OpenCode 的解析问题，涵盖 composer 会话 ID、会话元数据模型、超大 rollout 头、时间戳偏移、后代会话统计，以及无可见内容的会话与空本地命令。 (#281, #329, #335, #336, #339, #372, #373)
- 统一会话层级的消费方，并去重会话树路由键。 (#280, #338)
- 让实时更新保持在当前时间窗内，并释放已删除的兜底会话树。 (#298, #339)
- 校验并拒绝非法的会话查询参数与倒置或格式错误的日期区间。 (#297, #321, #340)
- 让 Web 各页面从失败中恢复，暴露持续断连与详情流失败，并保留侧栏键盘选择。 (#340, #341, #342)
- 修复 Dashboard 图表交互：限制入场动画进度、停止静止时的画布循环、去重悬停更新并恢复键盘访问。 (#311, #312, #313, #314)
- 恢复被拒绝的扫描 Worker 队列，保持回填队列推进，持久化回填检查点，在存在 SSE 连接时限时关停，并串行化 Worker 日志写入。 (#309, #310, #318, #328)
- 归一化 Project Identity 输入，保留数据库扫描窗口，并保留缓存中被省略的会话元数据。 (#317, #331, #332)

### 构建

- 在类型层强制 Node 22 运行时表面，约束 `apps/www` 的 Astro 源码质量，并将工具文件、根目录源码与 Agent 适配器纳入质量门禁覆盖。 (#289, #292, #319, #367, #369)
- Bundle 测试前强制先构建 Web，并默认发现新增的 e2e 用例。 (#323, #368)
- 升级 `actions/checkout`、`actions/upload-artifact`、`actions/download-artifact`、`pnpm/action-setup` 与 `softprops/action-gh-release`。 (#348, #349, #350, #351, #352)
- 移除未使用的图表依赖。 (#322)

### 文档

- 从 `engines` 推导 Node 基线，约束仓库事实一致性与必需 CI 检查清单，刷新并门禁化 Agent 映射，并补充远程访问安全、缓存连接生命周期与扫描同步接缝的文档。 (#291, #293, #302, #320, #354, #370)

### Changelog Detail

- #375 refactor(sqlite): remove duplicate message FTS @xingkaixin
- #374 fix: decouple full-history maintenance from publishing @xingkaixin
- #352 build(deps): bump actions/download-artifact from 4.3.0 to 8.0.1 @dependabot
- #351 build(deps): bump actions/checkout from 4.4.0 to 7.0.1 @dependabot
- #350 build(deps): bump actions/upload-artifact from 4.6.2 to 7.0.1 @dependabot
- #349 build(deps): bump pnpm/action-setup from 4.3.0 to 6.0.10 @dependabot
- #348 build(deps): bump softprops/action-gh-release from 2.6.2 to 3.0.2 @dependabot
- #371 Fix startup delays caused by cache cleanup @xingkaixin
- #372 fix(grok): filter sessions without visible messages @xingkaixin
- #373 fix(claude): filter empty local commands @xingkaixin
- #370 docs: enforce Node and CI facts @xingkaixin
- #369 chore(ci): close quality gate blind spots @xingkaixin
- #368 fix(ci): require web build for bundle tests @xingkaixin
- #367 test: cover agent adapters and route recovery @xingkaixin
- #366 refactor: consolidate shared failure and tool logic @xingkaixin
- #365 test(web): characterize tool strategies @xingkaixin
- #364 refactor(cache): unify search index planning @xingkaixin
- #363 perf(claudecode): preserve valid child index @xingkaixin
- #362 perf(cache): derive restored session order @xingkaixin
- #361 perf(analytics): reuse session trees per request @xingkaixin
- #360 perf(cli): reuse search index worker @xingkaixin
- #359 fix(cursor): bound composer scan cache @xingkaixin
- #358 perf(web): stabilize render hot paths @xingkaixin
- #357 perf(web): stream incremental live session updates @xingkaixin
- #356 perf(cli): reuse refresh cache snapshots @xingkaixin
- #355 feat(api): paginate session snapshots @xingkaixin
- #354 refactor(cache): reuse SQLite connections @xingkaixin
- #353 fix(cli): minimize credential and path exposure @xingkaixin
- #347 chore(ci): harden supply chain controls @xingkaixin
- #346 refactor(search): return structured highlights @xingkaixin
- #345 Add CSP and browser security headers @xingkaixin
- #344 fix(server): guard remote writes from cross-site requests @xingkaixin
- #343 Block agent scans from following symlinks @xingkaixin
- #342 fix(web): preserve sidebar keyboard selection @xingkaixin
- #341 Fix web failure recovery paths @xingkaixin
- #340 fix: harden API and bookmark edge cases @xingkaixin
- #339 fix: harden scan and index pipelines @xingkaixin
- #338 fix(session-tree): deduplicate route keys @xingkaixin
- #337 fix: preserve accurate cost sources @xingkaixin
- #336 fix: stabilize Cursor session parsing @xingkaixin
- #335 fix: harden Codex and Claude session parsing @xingkaixin
- #334 fix: preserve sync state after cache read failures @xingkaixin
- #333 fix: make session detail publication atomic @xingkaixin
- #332 fix(core): normalize project identity inputs @xingkaixin
- #331 fix: preserve database scan windows @xingkaixin
- #330 fix(search): preserve ranking and inclusive cost @xingkaixin
- #329 fix(core): correct Kimi session facts @xingkaixin
- #328 fix(cli): recover rejected scan queues @xingkaixin
- #327 fix(core): preserve stale pricing caches @xingkaixin
- #326 fix(cli): stop permanent startup rescan loop for SQLite-backed agents @xingkaixin
- #325 fix(core): attribute surplus codex usage to models in cost breakdown @xingkaixin
- #324 fix(core): stop permanent codex source-failure loop on startup @xingkaixin
- #323 test(e2e): discover new specs by default @xingkaixin
- #322 chore(web): remove unused chart dependencies @xingkaixin
- #321 fix(api): reject invalid date filters @xingkaixin
- #320 docs: refresh and gate agent map @xingkaixin
- #319 chore(quality): cover root source files @xingkaixin
- #318 fix(logging): serialize worker log writes @xingkaixin
- #317 fix(cache): preserve omitted session metadata @xingkaixin
- #316 fix: keep worker pricing generations consistent @xingkaixin
- #315 fix(cli): reject cross-site loopback writes @xingkaixin
- #314 fix(web): deduplicate bar chart hover updates @xingkaixin
- #313 fix(web): stop resting canvas chart loops @xingkaixin
- #312 fix(web): restore chart keyboard access @xingkaixin
- #311 fix(web): bound bar chart stagger progress @xingkaixin
- #310 fix(cli): persist backfill checkpoints @xingkaixin
- #309 fix(cli): bound shutdown with active SSE @xingkaixin
- #308 fix(cli): allow proxy authority on loopback @xingkaixin
- #307 fix(core): heal missing pricing across agents @xingkaixin
- #306 fix(core): isolate pre-staged session heads @xingkaixin
- #304 fix(core): re-parse cached session heads once missing model pricing arrives @xingkaixin
- #305 fix(core): pre-stage large search-index backlogs in durable chunks @xingkaixin
- #303 Redesign the dashboard charts @xingkaixin
- #302 refactor: centralize session source synchronization @xingkaixin
- #301 test(coverage): validate critical owners @xingkaixin
- #300 refactor(bookmarks): store reference facts @xingkaixin
- #299 fix: bound OpenCode related session scans @xingkaixin
- #298 fix: keep live updates inside the active window @xingkaixin
- #297 fix: validate session query parameters @xingkaixin
- #296 fix: preserve failed scan outcomes @xingkaixin
- #295 fix(sync): commit durable publications atomically @xingkaixin
- #294 fix(sync): preserve partial scan history @xingkaixin
- #293 fix(cli): require auth for loopback proxies @xingkaixin
- #292 build(www): enforce Astro source quality @xingkaixin
- #291 docs: enforce repository fact consistency @xingkaixin
- #290 fix(cache): preserve migration invariants @xingkaixin
- #289 build(types): enforce Node 22 runtime surface @xingkaixin
- #288 ci(release): verify the published npm artifact @xingkaixin
- #287 refactor(cli): retain scan worker baselines @xingkaixin
- #286 perf(core): bound recent session search @xingkaixin
- #285 Bound scan status delivery across the live pipeline @xingkaixin
- #284 Bound message FTS lookup per candidate session @xingkaixin
- #283 Refactor backfill lifecycle into explicit attempts @xingkaixin
- #282 fix(core): version persisted derived projections @xingkaixin
- #281 fix(core): align Kimi-Code source activity @xingkaixin
- #280 fix: unify session hierarchy consumers @xingkaixin
- #279 fix(cli): enforce loopback request authority @xingkaixin
- #278 fix: retain sessions when source parsing fails @xingkaixin
- #277 fix: preserve cache outside windowed scans @xingkaixin
- #276 fix(cache): version session detail projections @xingkaixin
- #275 fix(sync): reject non-durable checkpoints @xingkaixin
- #274 fix(core): keep session head stats local @xingkaixin


## [1.0.0] - 2026-08-07

本次大版本重建 CodeSesh 控制台与产品体验，新增 Grok 会话支持，并强化并发索引稳定性，推动项目进入 1.0 阶段。

### 新功能

- 新增 Grok 会话发现、ACP 转录重建、用量与成本记录、恢复命令，以及文件、终端和网页工具的语义化展示。 (#265)
- 围绕全局与项目 Dashboard 重建控制台，支持可比较与自定义日期范围、包含子会话的会话树指标、按模型成本、项目排行和趋势。 (#266)
- 新增以项目为中心的导航、原位展开的子会话时间线，以及会话阅读器中的两级内容与工具筛选。 (#266)
- 使用与控制台一致的视觉系统重设计双语产品站，新增响应式交互产品演示，并刷新 SEO、AEO、社交分享及面向 AI 的元数据。 (#267, #269)
- 在项目排行中以紧凑且无障碍的 Agent 图标替代 Agent 名称。 (#272)

### 破坏性变更

- 移除 `DashboardAggregate.dailyTokenActivity` 与 `DailyTokenBucket`；Token 明细现通过 `DashboardDailyBucket` 并入 `DashboardAggregate.dailyActivity`。Dashboard 总量现包含所有后代会话，而会话数仅统计顶层会话树，不再重复计算已挂载的子会话。 (#266)

### 问题修复

- 让侧栏选择保持唯一并与当前路由同步，避免键盘导航保留或重新打开过期选择。 (#268)
- 通过避免重复写入 schema、立即获取写事务并优先设置 busy timeout，消除并发缓存写入时的 SQLite 锁与快照失败。 (#270)
- 修正侧栏折叠与展开图标的方向。 (#270)

### 构建

- 更新工作区依赖，并调整构建、worker 与端到端配置，以适配当前 pnpm、Astro、Vite、SQLite、Hono 和 Playwright 版本。 (#271)

### Changelog Detail

- #272 feat(web): show only project agent logos @xingkaixin
- #271 chore(deps): update workspace dependencies @xingkaixin
- #270 fix: eliminate SQLite busy failures and swap sidebar toggle icons @xingkaixin
- #269 feat(www): redesign product landing page @xingkaixin
- #268 fix(web): prevent duplicate session selection @xingkaixin
- #267 feat(www): align landing with interactive console UI @xingkaixin
- #266 feat(web): rebuild the UI against the redesign prototype @xingkaixin
- fix: relocate agent-skills ignore entries to standard section @xingkaixin
- #265 feat(core): support Grok sessions @xingkaixin

## [0.19.0] - 2026-08-02

本版本将子 Agent 会话纳入嵌套会话树，新增 Kimi-Code 支持，并让大规模或中断的扫描能够续跑，同时改善长标题浏览与子 Agent 详情展示。

### 新功能

- 新增 Kimi-Code 会话发现、解析、工具展示和注册。 (#259)
- 新增嵌套会话树，保留父子关系，并为 ZCode、Codex 和 Claude Code 聚合子 Agent 的 Token 统计。 (#256, #257, #263)
- 新增带检查点的可恢复全历史索引，以分批回填和持久化扫描进度支持中断后继续。 (#260)

### 问题修复

- 在父会话详情中展示 Codex 子 Agent 的最终输出，并在父文件缺失时让 Claude 子会话继续作为根会话可见。 (#258, #263)
- 扫描期间保持时间窗外会话与 Agent 可用，并修正中断刷新时的扫描收尾和进度状态。 (#260)
- 让长会话标题平滑滚动，并在侧栏中保留父会话操作。 (#261, #262)

### 性能

- 每轮仅索引一次 Codex 子 Agent 文件，只重新解析变化源及受影响的父会话，并将大型搜索索引同步拆成可恢复的分批提交。 (#260)

### Changelog Detail

- #263 feat(core): support Claude Code subagents @xingkaixin
- #262 fix(web): keep session title scrolling readable @xingkaixin
- #261 feat(web): improve long session title behavior @xingkaixin
- #260 feat: add nested session trees and resumable scans @xingkaixin
- #259 feat(kimi-code): add Kimi-Code session support @xingkaixin
- #258 fix(core): surface Codex subagent output @xingkaixin
- #257 feat(core): fold Codex subagent sessions into parent @xingkaixin
- #256 feat(core): fold ZCode subagent sessions into parent @xingkaixin

## [0.18.0] - 2026-07-30

本版本保护远程与本地会话数据，避免失败或不完整的扫描破坏已发布状态，并消除大规模会话历史中的主要加载与渲染瓶颈。

### 新功能

- 新增加密远程访问，支持直接终止 TLS 和可信代理传输校验。 (#240)

### 安全

- 升级 Hono 服务并固定静态文件服务根目录边界，修复 Windows 静态路径遍历。 (#231)
- 阻止转录内容发起跨源媒体请求，并限制内联媒体载荷大小。 (#237)
- 将会话数据库、sidecar、备份和日志限制为仅所有者可访问。 (#249)

### 问题修复

- 仅在持久化与搜索索引成功后发布会话更新；Agent 扫描失败或暂时不可用时保留现有会话。 (#230, #238)
- 在文件指纹与监听中检测 WAL 模式的数据库提交。 (#239)
- 在路由、API 请求和 CLI 启动 URL 中完整保留不透明会话 ID。 (#233)
- 以日历日定义 Dashboard 时间窗口，正确处理夏令时切换。 (#234)
- 按不同会话限制文件活动结果，并让 Markdown 搜索高亮与当前查询保持同步。 (#235, #236)
- 让定价刷新具备原子性、时间边界和可取消能力，并在一次扫描代际内保持一致。 (#250)
- 稳定会话时间轴布局与详情查询，合并实时更新并批量流式传输详情，避免渲染和加载卡顿。 (#254)

### 性能

- 以摊销常数时间分配冲突的侧栏路径，并在线性单次扫描中读取 Cursor bubble。 (#232, #241)
- 以对数时间索引虚拟时间轴高度。 (#242)
- 按需加载路由界面与语法高亮，将初始 JavaScript 的 gzip 体积从 459 KB 降至 259 KB。 (#243)
- 通过单次查询读取会话全部部件，并将 Web 转录缓存限制为当前详情与最近两个详情。 (#247, #248)

### 重构

- 在共享契约中集中项目身份类型、键与比较逻辑。 (#252)

### 构建

- 新增发布预检，在发布前校验 tag 与所有带版本 manifest 的一致性。 (#244)
- 以跨平台脚本替代依赖 shell 的清理命令，并在 CI 的每种操作系统上验证清理后重新构建。 (#246)
- 在 CI 中新增结构化性能增长率门禁。 (#253)

### 文档

- 明确 `--json` 导出的是会话索引，而不是完整转录备份。 (#245)
- 将 PRD 明确为项目初始文档，并链接当前架构事实来源。 (#251)
- 记录性能保障的分层策略。 (#253)

### Changelog Detail

- #254 fix(web): prevent session timeline rendering and loading stalls @xingkaixin
- #253 chore(perf): gate performance structurally, not by wall-clock @xingkaixin
- #252 refactor: give project identity one owner @xingkaixin
- #251 docs: stop the PRD from describing a deleted architecture @xingkaixin
- #250 fix: make pricing refreshes deterministic @xingkaixin
- #249 fix: keep session storage and logs owner-only @xingkaixin
- #248 perf(web): bound how many transcripts the cache retains @xingkaixin
- #247 perf(core): read a session's parts in one query @xingkaixin
- #246 chore: make pnpm clean work on Windows @xingkaixin
- #245 docs: describe --json as a session index @xingkaixin
- #244 chore: verify release versions before publishing @xingkaixin
- #243 perf: load route surfaces on demand @xingkaixin
- #242 perf(web): index virtual list heights logarithmically @xingkaixin
- #241 perf: read Cursor bubbles once per scan @xingkaixin
- #240 feat: encrypt remote access transport @xingkaixin
- #239 fix: detect WAL-mode database commits @xingkaixin
- #238 fix: never read a failed database scan as an empty agent @xingkaixin
- #237 fix: keep transcript media local @xingkaixin
- #236 fix(web): render search highlights through the markdown tree @xingkaixin
- #235 fix(core): limit file activity search by session, not row @xingkaixin
- #234 fix: define dashboard windows in calendar days @xingkaixin
- #233 fix: carry opaque session ids through routes and the API @xingkaixin
- #232 perf(web): allocate sidebar paths in amortized constant time @xingkaixin
- #231 fix: close the Windows static path traversal @xingkaixin
- #230 fix: gate session publication on successful persistence @xingkaixin

## [0.17.0] - 2026-07-27

本版本强化大规模历史在扫描、API 与会话时间轴上的性能，修复可能导致会话丢失或过期的实时扫描与缓存正确性问题，并围绕显式会话引用与集中化 Agent 能力重构领域契约。

### 性能

- 以流式方式读取 Agent 转录，并在单次扫描中解析 Pi 会话，避免整文件载入内存；将 Kimi 源枚举与转录读取路径解耦。 (#190, #192, #193)
- 缓存会话别名读模型与快照聚合 API 响应，并优化会话详情载荷。 (#196, #214, #215)
- 合并各 Agent 的实时会话分片时不再全量重排；复用 CLI 刷新 worker 并返回增量 delta。 (#197, #209)
- 虚拟化 Web 会话时间轴，改善长历史滚动体验。 (#213)

### 问题修复

- 以线性时间组装跨块的长 JSONL 记录。 (#191)
- 停止删除落在当前扫描窗口之外的已缓存会话。 (#198)
- 在 Web 导航中保留会话引用身份；统一实时缓存失效与跨源搜索筛选。 (#200, #201, #202)
- 统一会话发布提交，并将数据库刷新扫描卸载到 worker，保持 CLI 事件循环响应。 (#203, #208)
- 缓存会话索引快照，并在滚动时复用已渲染的消息 Markdown。 (#211, #212)
- 在 API 中区分别名校验错误。 (#226)
- 避免启动时阻塞于消息迁移，并跳过打开数据库时昂贵的 FTS 完整性检查。 (#227, #228)

### 重构

- 显式建模会话引用，规范化消息部件与公共领域术语。 (#216, #217, #218, #219)
- 集中 Agent 能力、文件源与会话监听计划；共享单次源变更检测。 (#194, #204, #220, #221)
- 物化会话详情，收窄缓存 schema 边界，并移除缓存影子写入。 (#205, #206, #210)
- 统一 Web 会话详情模型并共享文件工具策略；将 Web 与产品站图标从 Lucide 迁移到 Hugeicons。 (#199, #207, #224)
- 拆分 API handler 与 AgentSyncEngine 职责；收紧 core 公共导出。 (#195, #223, #225)

### 文档

- 刷新扫描与缓存架构文档。 (#222)

### Changelog Detail

- #228 fix(cache): avoid startup FTS integrity checks @xingkaixin
- #227 fix(cache): avoid blocking startup on message migration @xingkaixin
- #226 fix(api): distinguish alias validation errors @xingkaixin
- #225 refactor(core): tighten public exports @xingkaixin
- #224 refactor(web): share file tool strategies @xingkaixin
- #223 refactor(cli): split AgentSyncEngine responsibilities @xingkaixin
- #222 docs: refresh scanning architecture @xingkaixin
- #221 refactor(agents)!: centralize agent capabilities @xingkaixin
- #220 refactor(agents): centralize file sources @xingkaixin
- #219 refactor(domain)!: align public terminology @xingkaixin
- #218 refactor(contract)!: normalize message parts @xingkaixin
- #217 refactor(contract)!: unify session references @xingkaixin
- #216 refactor: model session references explicitly @xingkaixin
- #215 perf: optimize session detail responses @xingkaixin
- #214 perf(api): cache snapshot aggregate responses @xingkaixin
- #213 perf(web): virtualize session timeline @xingkaixin
- #212 fix(web): reuse message markdown while scrolling @xingkaixin
- #211 fix(core): cache session index snapshots @xingkaixin
- #210 refactor(core): remove cache shadow writes @xingkaixin
- #209 perf(cli): reuse refresh workers and return deltas @xingkaixin
- #208 fix(cli): offload database refresh scans @xingkaixin
- #207 refactor(web): unify session detail model @xingkaixin
- #206 refactor(core): materialize session details @xingkaixin
- #205 refactor(core): narrow cache schema boundary @xingkaixin
- #204 refactor(agents): own session watch plans @xingkaixin
- #203 fix(cli): unify session publication commits @xingkaixin
- #202 fix(web): unify live cache invalidation @xingkaixin
- #201 fix(search): unify cross-source filters @xingkaixin
- #200 fix(web): preserve session reference identity @xingkaixin
- #199 refactor(icons): migrate web and www from lucide to hugeicons @xingkaixin
- #198 fix(agents): stop deleting cached sessions outside the scan window @xingkaixin
- #197 perf(live): merge per-agent session shards instead of re-sorting @xingkaixin
- #196 perf(api): cache the session alias read model @xingkaixin
- #195 refactor(api): split handlers into parsing, aliases and analytics @xingkaixin
- #194 refactor(agents): share one source change-detection pass @xingkaixin
- #193 perf(agents): stream transcripts instead of loading whole files @xingkaixin
- #192 perf(pi): parse session files in one streaming pass @xingkaixin
- #191 fix(jsonl): assemble long records in linear time @xingkaixin
- #190 perf(kimi): keep source enumeration off transcripts @xingkaixin

## [0.16.0] - 2026-07-23

本版本为 Web 应用与产品站新增可持久化的浅色、深色和跟随系统主题，提升实时会话正确性与大规模历史数据性能，并强化诊断能力、无障碍体验和生产质量门禁。

### 新功能

- 为 Web 应用与产品站新增浅色、深色和跟随系统主题控制，包括偏好持久化、适配主题的 Agent 图标、代码高亮和工具输出颜色。 (#178, #179, #180)
- 持久化带版本管理的应用外壳 UI 偏好。 (#159)
- 新增 Core 诊断通道和 CLI 日志桥接，让此前静默的适配器、缓存、JSONL 与 SQLite 故障可观测。 (#160)
- 重新设计产品落地页，优化信息区块、布局与无障碍语义。
- 通过共享 token 和 transition 统一 Web 交互动效。 (#170)

### 问题修复

- 实时扫描时刷新已变化的会话详情，避免当前打开的会话继续显示过期内容。 (#184)
- 将 head cache 初始化与搜索索引完整性解耦，并避免每次打开数据库都重写状态 schema。 (#161, #165)
- 基于 Base UI 重建侧栏会话操作菜单，并改进扫描状态与复制反馈的辅助技术播报。 (#172, #173)
- 恢复产品展示弹窗标签，并隔离端到端测试中的可变 fixture。 (#157, #181)

### 性能

- 消除扫描热路径中的重复枚举、文件 stat 与解析，缓存事件路径签名和项目身份，并直接匹配别名以避免重新执行完整搜索。 (#162, #163, #164, #166)
- 虚拟化大型扁平会话列表，修正分组会话排序，压缩 API 响应，并使用 `IntersectionObserver` 跟踪时间轴锚点。 (#167, #168)
- 优化产品站以获得满分 Lighthouse 指标，并将生产分析脚本与本地、预览构建隔离。 (#188)

### 无障碍

- 改进表单错误关联、跳转链接与标题层级、时间轴点击目标尺寸、数字可读性和侧栏交互语义。 (#171, #174, #175)

### 重构

- 在适配器解析边界校验外部数据，并通过漂移报告统一字段收窄。 (#176, #177)
- 将 Web surface 色彩集中为主题 token，以声明式路由匹配替代 pathname 解析，并使用 TanStack Query 统一远程状态。 (#156, #158, #169)

### 测试

- 扩展运行计划、语义化工具输出、实时刷新和跨 Agent 聚合覆盖，改进端到端失败诊断，并将覆盖率门禁扩展到全部生产源码。 (#182, #183, #185, #186, #187)

### Changelog Detail

- #188 perf(www): achieve perfect Lighthouse scores @xingkaixin
- #187 test(e2e): cover cross-agent aggregation @xingkaixin
- #186 test(e2e): improve failure diagnostics @xingkaixin
- #185 test(cli): cover runtime plan @xingkaixin
- #184 fix(live): refresh changed session details @xingkaixin
- #183 test(web): cover semantic tool outputs @xingkaixin
- #182 test(coverage): gate all production source @xingkaixin
- #181 fix(e2e): isolate mutable fixtures @xingkaixin
- #180 fix: adapt agent icons and tool output colors to dark mode @xingkaixin
- #179 feat(www): add dark mode to landing page @xingkaixin
- #178 feat(web): add dark mode with theme toggle @xingkaixin
- #177 refactor(core): unify field narrowing via narrowField @xingkaixin
- #176 refactor: validate external data at adapter parse boundaries @xingkaixin
- #175 chore(web): widen timeline hit targets to 24px @xingkaixin
- #174 chore(web): fix form error wiring, skip link, heading levels @xingkaixin
- #173 fix(web): rebuild sidebar session menu on Base UI Menu @xingkaixin
- #172 fix(web): announce scan status and copy feedback politely @xingkaixin
- #171 chore(web): enable tabular figures in console mono @xingkaixin
- #170 feat(web): unify motion tokens and interaction transitions @xingkaixin
- #169 refactor(web): consolidate surface colors into tokens @xingkaixin
- #168 perf(web): track timeline anchors with IntersectionObserver @xingkaixin
- #167 perf: sidebar scalability — list virtualization, sort fix, API compression @xingkaixin
- #166 perf(core): cache project identity per process with TTL @xingkaixin
- #165 fix: decouple head cache init from search index completeness @xingkaixin
- #164 perf(cli): match aliases directly instead of full re-search @xingkaixin
- #163 perf: cache event-path session signatures per agent @xingkaixin
- #162 perf: eliminate redundant enumeration, stat and parse in scan hot path @xingkaixin
- #161 fix(core): stop rewriting state schema on every db open @xingkaixin
- #160 feat: add core diagnostics channel for silent failures @xingkaixin
- #159 feat(web): persist app shell UI preferences @xingkaixin
- #158 refactor(web): replace pathname parsing with route matches @xingkaixin
- #157 fix(www): restore showcase dialog label @xingkaixin
- #156 refactor(web): unify remote state with TanStack Query @xingkaixin
- feat(www): redesign landing page sections with improved layout and a11y @xingkaixin

## [0.15.0] - 2026-07-20

本版本让会话中的工具调用更易读：将 Codex code-mode 的 exec 调用解码还原为原生工具展示，工具以语义化方式可视化呈现，时间轴还会按活动类型为工具着色。

### 新功能

- 将 Codex code-mode 的 `exec` 工具调用解码还原为原生工具展示（bash、patch、write_stdin、node_repl、subagent、MCP），为 `update_plan`、`web__run` 和 `view_image` 新增专用渲染，把多调用 exec 程序拆分为有序的工具片段，并通过轻量的 pending-reindex 迁移在升级时刷新已缓存的过期 Codex 详情。 (#152)
- 新增语义化工具可视化与 Claude 消息的语义化渲染，同时保留 Claude 工具图片与 task 工具。 (#153)
- 时间轴工具按活动分类着色。 (#154)

### Changelog Detail

- #154 feat: color timeline tools by activity @xingkaixin
- #153 feat: add semantic tool visualizations @xingkaixin
- #152 feat(codex): decode code-mode exec into native tool displays @xingkaixin

## [0.14.0] - 2026-07-18

本版本新增持久化会话别名和交互式时间范围筛选，同时提升导航、动效和搜索回填的可靠性与内存效率，并进一步收敛内部模块边界。

### 新功能

- 新增持久化本地会话别名，并在会话列表、收藏、活动视图、详情和搜索结果中统一展示。 (#132)
- 新增 Web 时间范围预设和自定义日期范围，配合完整历史回填，让 Dashboard、项目、Agent、会话、搜索和实时更新统一遵循所选范围。 (#133)
- 优化导航和临时浮层动效，并支持 reduced motion 偏好。 (#135)

### 问题修复

- 对齐路由派生的导航与搜索上下文状态，取消过期的时间窗口请求，并让滚动时间预设始终保持最新。 (#136, #137, #138)
- 恢复关闭会话操作菜单后的键盘焦点。 (#139)
- 恢复拖拽 receipt 的动效，并以流式方式回填搜索索引，避免将完整历史一次性载入内存。 (#141)

### 文档

- 修正架构与工具链文档偏差。 (#140)

### 重构

- 统一文件型 Agent 的 transcript 组装与扫描收尾，并集中缓存元数据、Agent 注册表元数据和会话归一化的事实来源。 (#143, #144, #145)
- 集中 CLI Agent 同步生命周期、扫描接口和时间窗口解析。 (#146, #147)
- 合并 Web 会话刷新状态，提取应用外壳模型，并在 Core、CLI 和 Web 之间集中 Agent 身份元数据。 (#148, #149, #150)

### 测试

- 扩展 Core、CLI 和 Web 的单元测试覆盖与质量门禁，并为缓存、定价、状态和工具模块增加独立测试 seam。 (#134, #142)

### Changelog Detail

- #150 refactor: centralize agent identity metadata @xingkaixin
- #149 refactor(web): extract app shell models @xingkaixin
- #148 refactor(web): consolidate session data refresh @xingkaixin
- #147 refactor(cli): centralize scan interfaces and time windows @xingkaixin
- #146 refactor(cli): centralize agent sync lifecycle @xingkaixin
- #145 refactor: consolidate core and CLI truth sources @xingkaixin
- #144 refactor(core): centralize scan finalization @xingkaixin
- #143 refactor(core): unify file agent transcript assembly @xingkaixin
- #142 test(core): add per-module test seams @xingkaixin
- #141 fix: restore receipt motion and stream search backfill @xingkaixin
- #140 docs: correct architecture and tooling drift @xingkaixin
- #139 fix(web): restore session menu keyboard focus @xingkaixin
- #138 fix(web): keep rolling time windows current @xingkaixin
- #137 fix(web): cancel stale window data loads @xingkaixin
- #136 fix(web): align route-derived navigation state @xingkaixin
- #135 feat(web): refine navigation and transient motion @xingkaixin
- #134 test: improve unit test coverage @xingkaixin
- #133 feat: add session time range filtering @xingkaixin
- #132 feat: add local session aliases @xingkaixin

## [0.13.0] - 2026-07-12

本版本为长会话增加时间线导航，提升扫描与搜索的可靠性，并强化远程访问安全性和构建校验。

### 新功能

- 新增固定在会话详情顶部的消息时间线，提供 Canvas 绘制的 minimap、视口跟踪以及点击或拖拽导航，方便浏览长会话。 (#101)
- 新增带认证的远程会话访问，安全地将会话服务到本机之外。 (#114)

### 问题修复

- 项目身份同时包含项目类型和项目键，隔离原始键冲突的项目；项目筛选 API 现在必须同时提供两个字段。 (#102)
- 按 Agent 串行执行扫描任务，原子停止搜索 worker，正确收敛提前退出的 worker，清理取消的 SSE 流，并在关闭时停止活动扫描。 (#103, #104, #115, #116, #117)
- 路由变化或刷新后不再提交过期的会话详情响应，并让搜索失败可以恢复。 (#105, #119)
- 为 Dashboard 图表补充键盘访问支持，并处理产品站点的剪贴板失败场景。 (#121, #122)
- 解析 Codex 超过 400 MB 的会话时改为流式读取 JSONL，避免 worker 因内存不足退出。 (#101)
- 优化展示页动效和文案。 (#130)

### 性能

- 批量更新增量搜索索引状态，合并待处理索引任务，文件专属搜索跳过冗余会话查询，并限制 receipt 模拟工作量。 (#107, #108, #112, #129)

### 构建

- 并行安装 TypeScript 7 与 TypeScript 6，并改用 TypeScript 6 生成 Core 声明文件。 (#100)
- 升级依赖和 pnpm 11.11.0，将 Dialog 实现从 Radix UI 迁移到 Base UI，并让 CLI 构建与发布执行类型检查。 (#111, #113)
- 发布后的 CLI 现在要求 Node.js 22 或更高版本。 (#118)

### 重构

- 为 Core、CLI 和 Web 增加浏览器安全的共享 HTTP contract，并集中管理会话搜索语义与会话索引。 (#109, #110, #124)
- 统一详情抽屉行为，移除虚拟列表轮询，明确实时扫描生命周期归属，按路由模块组合 Web 应用，并按职责拆分搜索缓存模块。 (#120, #123, #125, #126, #127)

### 测试

- 修正按包配置的 Vitest 环境，建立网站交互测试覆盖，并在 CI 中为高风险覆盖范围设置门禁。 (#106, #122, #128)

### Changelog Detail

- #130 fix(ui): polish showcase motion and copy @xingkaixin
- #129 perf(web): cap receipt simulation work @xingkaixin
- #128 test(ci): gate high-risk coverage scopes @xingkaixin
- #127 refactor(core): split search cache modules @xingkaixin
- #126 refactor(web): compose app from route modules @xingkaixin
- #125 refactor(cli): deepen live scan lifecycles @xingkaixin
- #124 refactor(core): centralize session indexing @xingkaixin
- #123 refactor(web): remove virtual list polling @xingkaixin
- #122 test(e2e): establish website interaction baseline @xingkaixin
- #121 fix(web): add keyboard access to charts @xingkaixin
- #120 refactor(web): unify detail drawer behavior @xingkaixin
- #119 fix(web): make search failures recoverable @xingkaixin
- #118 chore(cli)!: require Node.js 22 @xingkaixin
- #117 fix(cli): stop active scans on shutdown @xingkaixin
- #116 fix(cli): clean up cancelled SSE streams @xingkaixin
- #115 fix(cli): settle early scan worker exits @xingkaixin
- #114 fix: secure remote access @xingkaixin
- #113 chore(deps): upgrade packages and migrate to base-ui @xingkaixin
- #112 perf(search): skip redundant sessions query for file-only search @xingkaixin
- #111 chore: add type-check gate to cli package @xingkaixin
- #110 refactor: deep session search module @xingkaixin
- #109 refactor: browser-safe HTTP contract module @xingkaixin
- #108 perf(search): coalesce pending index jobs @xingkaixin
- #107 perf(search): batch incremental index state @xingkaixin
- #106 fix(test): honor project Vitest environments @xingkaixin
- #105 fix(web): cancel stale session detail requests @xingkaixin
- #104 fix(live-scan): stop search workers atomically @xingkaixin
- #103 fix(live-scan): serialize agent scan operations @xingkaixin
- #102 fix(projects)!: use composite project identities @xingkaixin
- #101 feat(web): session message timeline with minimap navigation @xingkaixin
- #100 chore: dual-install TypeScript 7 and 6 @xingkaixin

## [0.12.0] - 2026-07-03

本版本重点强化扫描刷新性能、本地服务安全性和 Web 实时更新稳定性，同时继续拆分 Web UI 模块，提升可维护性。

### 问题修复

- 消除扫描卡顿、重复重扫和过期扫描状态：将项目身份收尾移入 refresh worker，缓存 schema 初始化，避免重复 FTS 完整性检查，并对快速变化的会话刷新做节流。 (#98)
- 将增量扫描限制在当前展示时间窗口内，并把全历史对账移入低优先级后台流程，降低大历史记录下的启动和刷新成本。 (#89)
- CLI HTTP 服务默认绑定到 `127.0.0.1`，并新增显式 `--host` 选项用于外部访问，避免未认证的本地会话数据默认暴露到局域网。 (#90)
- Web SSE 连接在关闭或 CLI 重启后会自动重连，包含退避、补齐刷新和持续的重连提示。 (#93)

### 改进

- 使用 Radix Dialog 改进快捷键帮助弹窗的焦点管理、键盘和遮罩关闭、兼容 reduced-motion 的动效，并简化快捷键分组。 (#97)

### 重构

- 提取 Web 数据 hooks、侧边栏、键盘快捷键、会话详情子模块、格式化 helper、API helper 和各 Agent 的工具策略，减小 `App` 与 `SessionDetail` 体积并提升可测试性。 (#74, #75, #76, #77, #78, #79, #80, #81, #83, #84, #85, #86, #87, #91, #92, #94, #95)
- 将 `LiveScanStore` 刷新状态合并为单个 map，并移除 cache/search 中的废弃导出。 (#82, #96)

### 测试

- 补齐 dashboard `SessionStats` fixtures，并扩展扫描行为、Web hooks、API helper 与格式化模块的测试覆盖。 (#88)

### Changelog Detail

- #98 fix: eliminate scan stalls, redundant rescans, and stale scanning status @xingkaixin
- #97 chore(web): polish shortcut help dialog with Radix and motion @xingkaixin
- #96 refactor(cli): consolidate LiveScanStore refresh state into one map @xingkaixin
- #95 refactor(web): split tool-strategy.ts into per-agent files @xingkaixin
- #94 refactor(web): extract AppSidebar, useKeyboardShortcuts, ShortcutHelpDialog from App.tsx @xingkaixin
- #93 fix(web): reconnect SSE stream after it fully closes @xingkaixin
- #92 refactor(web): extract fetchJson helper in api.ts @xingkaixin
- #91 refactor(web): consolidate format helpers into lib/format @xingkaixin
- #90 fix(cli): bind HTTP server to loopback by default @xingkaixin
- #89 fix: bound incremental scans to the display window @xingkaixin
- #88 test(core): complete dashboard SessionStats fixtures @xingkaixin
- #87 refactor(web): extract session-detail-aux from SessionDetail @xingkaixin
- #86 refactor(web): extract message-list virtualization @xingkaixin
- #85 refactor(web): extract message-rendering from SessionDetail @xingkaixin
- #84 refactor(web): extract session-toc from SessionDetail @xingkaixin
- #83 refactor(web): extract file-change-tracker from SessionDetail @xingkaixin
- #82 refactor(core): collapse dead exports in cache/search.ts @xingkaixin
- #81 refactor(web): extract useInitialLoad and useLiveSync @xingkaixin
- #80 refactor(web): extract base data-layer hooks @xingkaixin
- #79 refactor(web): extract dashboard hooks @xingkaixin
- #78 refactor(web): extract useBookmarks hook @xingkaixin
- #77 refactor(web): extract useSessionSearch hook @xingkaixin
- #76 refactor(web): extract useSessionDetail hook @xingkaixin
- #75 refactor(web): extract useScanStatus hook @xingkaixin
- #74 refactor(web): table-dispatch tool strategy @xingkaixin

## [0.11.0] - 2026-06-23

### 新功能

- 新增 ZCode coding agent 支持，包括本地会话发现、OpenCode 兼容 SQLite 解析、实时监听目标、Web UI 图标覆盖和 ZCode 专属工具展示。 (#72)

### 问题修复

- 改进会话详情相关的 Web 布局行为：平板视口下折叠侧栏、覆盖展示 session receipt、在 paint 前测量虚拟行，并让应用侧边栏可折叠。 (#72)

### 重构

- 提取共享 OpenCode SQLite source，让 OpenCode 兼容 Agent 复用同一套解析逻辑，避免适配器重复实现。 (#72)

### Changelog Detail

- #72 feat(agents): add ZCode session support @xingkaixin

## [0.10.0] - 2026-06-22

本版本以内部架构重构为主，覆盖 core、CLI 与 Web，将多个大模块拆分为职责单一的模块，提升可维护性。

### 问题修复

- 恢复 IBM i 平台的递归文件监听支持，让该平台上的实时会话刷新重新可用。 (#70)
- 修正产品落地页 SEO/AEO 元数据中的不一致。 (#57)

### 文档

- 将 `llms-full.txt` 的构建要求同步为 Node 24 与 pnpm 11.5.1。 (#68)

### 重构

- 重塑 Agent 适配器 seam，集中变更检测逻辑。 (#58)
- 缓存模块按职责拆分，并收敛共享的扫描编排 helper。 (#59, #60)
- 从 `LiveScanStore` 提取 `SessionWatcher` 深模块，并将 Dashboard 聚合下沉到 core。 (#61, #62)
- 拆分 Web 端 `App` 与 `SessionDetail`，抽出工具归一化、路径提取、diff、文件变更、工具策略等纯逻辑模块与子组件。 (#63, #64, #65, #66, #67)

### 测试

- 将项目身份测试与宿主 `/tmp` 上的 manifest 隔离。 (#69)

### Changelog Detail

- #70 fix(watcher): restore ibmi recursive watch support @xingkaixin
- #69 test: isolate project identity from host /tmp manifests @xingkaixin
- #68 fix(www): sync llms-full.txt build requirements to Node 24 / pnpm 11.5.1 @xingkaixin
- #67 refactor(web): extract App subcomponents @xingkaixin
- #66 refactor(web): extract App pure logic into lib modules @xingkaixin
- #65 refactor(web): extract tool-strategy module from SessionDetail @xingkaixin
- #64 refactor(web): extract path-extract, diff, file-change modules @xingkaixin
- #63 refactor(web): extract tool-normalize module from SessionDetail @xingkaixin
- #62 refactor(analytics): sink dashboard aggregation to core @xingkaixin
- #61 refactor(cli): extract SessionWatcher deep module from LiveScanStore @xingkaixin
- #60 refactor(scan): converge shared orchestration helpers @xingkaixin
- #59 refactor(cache): split god module by concern @xingkaixin
- #58 refactor(agent): reshape adapter seam for change detection @xingkaixin
- #57 fix(www): correct landing page SEO/AEO inconsistencies @xingkaixin

## [0.9.1] - 2026-06-17

### 新功能

- 会话详情中的恢复命令复制现已支持 Pi，与其他受支持 Agent 一致。 (#55)

### 问题修复

- 对 Claude Code 按请求的 usage 成本去重，避免同一段 usage 重复计入导致 Token 与成本汇总偏高。 (#54)

### Changelog Detail

- #55 feat(resume): add Pi session command @xingkaixin
- #54 fix(claude): dedupe request usage costs @xingkaixin

## [0.9.0] - 2026-06-16

### 新功能

- 新增 Pi coding agent 支持，包括本地会话发现、解析、Agent 注册、图标、CLI 包元数据、README 覆盖和产品落地页文案。 (#49, #52)

### 问题修复

- 当前统计范围内会话数为 0 的 Agent 不再显示，避免未使用或统计期内未活跃的 Agent 干扰 Dashboard 汇总。 (#48)
- 支持在已知会话工作目录时，为各 Agent 的工具展示使用相对文件路径，减少会话详情中的绝对路径噪音。 (#50)
- 会话详情左侧目录筛选改为三态选择，用户可以快速清空当前已选分组，并看到部分选择状态。 (#51)

### Changelog Detail

- #52 feat(www): add Pi to landing page @xingkaixin
- #51 fix(web): add TOC tool filter tristate @xingkaixin
- #50 fix(agent): show relative tool paths @xingkaixin
- #49 feat(agent): add Pi session support @xingkaixin
- #48 fix(api): hide empty agents @xingkaixin

## [0.8.0] - 2026-06-05

### 新功能

- Web UI 新增可选的 React 渲染 profiler，支持通过 localStorage 开关采集组件渲染耗时、自定义会话详情测量，并可选择记录慢提交事件。 (#45)

### 性能

- 会话详情 receipt 延后渲染，并 memoize 侧边栏与收藏相关 handler，减少重型详情页和会话树渲染工作。 (#45)
- 扩展性能 benchmark 脚本，支持 warm/cold 缓存模式、直接访问或点击导航、代表性目标选择、`--days 0`、React profile 采集和更完整的超时诊断。 (#45)

### 构建

- pnpm 升级到 11.5.1，并在 `mise.toml` 中固定；CI/release workflow 改为使用仓库声明的 package manager 版本。 (#46)
- 更新 CLI、core、Web app、落地页和测试工具链依赖，包括 React、React Router、Hono、better-sqlite3、Tailwind、Vite、Astro、Vitest、Playwright、oxlint 和 Turbo。 (#46)

### Changelog Detail

- #46 build: upgrade dependencies and pnpm @xingkaixin
- #45 feat(perf): add benchmark profiling @xingkaixin

## [0.7.2] - 2026-05-30

### 问题修复

- 启动刷新改为不阻塞服务可用性，后台刷新继续执行时 HTTP 服务可以先启动。 (#42)
- 避免 Codex index 元数据更新触发重复刷新风暴。 (#43)

### 文档

- 增加动态 CodeSesh logo，并更新 README 品牌展示。

### Changelog Detail

- #43 fix(codex): avoid refresh storms from index updates @xingkaixin
- #42 fix: avoid blocking startup refresh @xingkaixin

## [0.7.1] - 2026-05-22

### 问题修复

- 文件活动读取优先使用只读缓存连接，仅在路径筛选需要 FTS 时回退到可写连接。 (#40)

### Changelog Detail

- #40 fix: avoid writable file activity reads @xingkaixin

## [0.7.0] - 2026-05-22

### 新功能

- 会话详情中的恢复命令复制扩展到更多受支持 Agent，不再只覆盖 Claude Code。 (#19)
- Codex scratch chats 会按稳定项目身份聚合，临时 Codex 会话更容易归类浏览。 (#32)
- 改进会话缓存初始化，让 Web UI 启动时更可靠地拿到一致的缓存状态。 (#38)

### 问题修复

- 修复项目身份缓存、实时刷新增量持久化、服务前缓存同步、刷新时项目身份归一化和冷启动会话详情等边界问题。 (#20, #22, #31, #34, #37)
- 修复搜索和文件活动热路径，移除 message match N+1，并优化文件活动检索。 (#23, #24)
- HTTP 端口不可用时新增动态端口 fallback。 (#28)
- 优化 Codex 工具展示，并归一化 namespaced Codex 工具标签。 (#35, #36)

### 性能

- 优化 Dashboard 聚合、会话详情渲染、前端会话派生索引、启动扫描、后续操作热点和启动刷新调度。 (#21, #25, #26, #27, #29, #33)
- 增加会话缓存 fingerprint，减少不必要的缓存刷新。 (#30)

### Changelog Detail

- #38 feat: improve session cache initialization @xingkaixin
- #37 fix: handle cold-start session details @xingkaixin
- #36 fix: improve Codex tool display @xingkaixin
- #35 fix(codex): normalize namespaced tool labels @xingkaixin
- #34 fix(cli): normalize project identity on refresh @xingkaixin
- #33 perf: defer startup refresh @xingkaixin
- #32 [codex] Group Codex scratch chats @xingkaixin
- #31 fix(cli): sync session cache before serving @xingkaixin
- #30 perf: track session cache fingerprints @xingkaixin
- #29 perf: improve startup scan performance @xingkaixin
- #28 fix(cli): add dynamic port fallback @xingkaixin
- #27 perf: fix follow-up performance hotspots @xingkaixin
- #26 perf(web): index app session derivations @xingkaixin
- #25 perf(web): optimize session detail rendering @xingkaixin
- #24 fix: optimize file activity search @xingkaixin
- #23 fix(search): remove message match N+1 @xingkaixin
- #22 fix: persist live refresh incrementally @xingkaixin
- #21 perf: optimize dashboard aggregation @xingkaixin
- #20 fix: cache project scope identity @xingkaixin
- #19 feat(web): add agent resume copy commands @xingkaixin

## [0.6.1] - 2026-05-12

### 问题修复

- 修复基于路径的项目详情路由，项目 route key 现在使用单层编码。 (#18)

### Changelog Detail

- #18 fix(projects): use single route encoding @xingkaixin

## [0.6.0] - 2026-05-12

### 新功能

- 新增项目浏览模式，支持 `/projects` 项目总览、项目级 Dashboard、跨 Agent 项目会话导航，并在路由中保留项目身份。 (#17)
- 新增结构化全局搜索，支持通过查询限定符和界面筛选按 Agent、项目、智能标签、工具、文件活动和成本区间检索。 (#16)
- 新增全局文件活动索引，从工具调用中记录 read、edit、write、delete 事件，并接入搜索和 API 筛选。 (#15)
- 新增 SQLite schema 迁移与备份机制，让本地会话缓存、搜索、收藏和文件活动存储可以随版本演进。 (#9)
- Claude Code 会话详情新增复制恢复命令按钮，可生成兼容 worktree 的 `claude --resume` 命令。 (#6)

### 稳定性

- 统一各 Agent 解析后的内容清理流程，集中处理内部工具和事件噪声。 (#13)
- 规范化会话持久化，补齐结构化会话行、父会话 upsert、项目身份回填和文件活动数据写入。 (#11)
- 强化 LiveScan watcher 刷新链路，并增加非递归监听回退。 (#10)

### 性能

- 优化 FTS 批量同步，按更新规模选择 bulk/incremental 模式，并增强触发器持久性。 (#12)

### 测试

- 新增 Playwright e2e 覆盖和 SQLite 迁移 smoke tests，并提高迁移测试在慢环境中的超时时间。 (#14)

### Changelog Detail

- #17 feat(projects): add project browse mode @xingkaixin
- #16 Add structured global search @xingkaixin
- #15 Add global file activity index @xingkaixin
- #14 Add e2e and migration smoke tests @xingkaixin
- #13 feat(core): unify agent parse cleanup @xingkaixin
- #12 perf(search): optimize FTS bulk sync @xingkaixin
- #11 feat(cache): normalize session persistence @xingkaixin
- #10 refactor: harden livescan watcher @xingkaixin
- #9 feat: Add SQLite migrations and backups @xingkaixin
- #6 feat(web): add copy-resume-command button to Claude Code sidebar @nengqi

## [0.5.0] - 2026-05-02

- feat(core): 增加智能标签分类，覆盖修复、重构、功能开发、测试、文档、规划、Git、构建发布和探索类会话
- feat(core): 增加价格数据、模型别名和成本估算，支持仅记录 Token 用量的会话展示估算成本
- feat(codex): 从 token count 事件中解析模型用量
- feat(web): 增加按项目组织的会话树侧边栏，并支持收藏切换和智能标签筛选
- feat(web): 会话详情页增加交互式 receipt 摘要
- feat(web): 使用 Recharts 优化 Dashboard 图表，并替换工具输出高亮实现
- feat(cli): 增加本地结构化日志、前端 UI 事件日志和性能 benchmark 脚本
- feat(www): 增加 SEO 元数据、Open Graph/Twitter Card、sitemap、robots.txt 和社交预览图
- fix(cli): 发布后的 CLI 继续兼容 Node.js 18，运行时文件监听使用 `chokidar` v4
- test: 增加 live scan store、Kimi 缓存刷新、项目身份、价格估算和文件系统相关测试

## [0.4.1] - 2026-04-24

- fix(cli): 在发布后的 CLI 包中包含 SQLite 运行时依赖
- fix(api): SQLite 状态存储不可用时，收藏接口保持稳定响应

## [0.4.0] - 2026-04-24

- feat(bookmarks): 增加基于 SQLite 持久化的会话收藏，并提供 API 路由与 Web UI 操作
- feat(web): 会话详情目录增加文件变更追踪，支持快速定位读写、编辑、删除等文件操作
- feat(web): Codex patch 查看器支持删除和移动文件操作展示
- feat(web): 增加键盘导航和快捷键面板
- feat(web): Dashboard 增加 Token 与模型分析，并展示 Claude 缓存 Token 指标
- feat(www): 产品落地页增加截图导览、跑马灯展示和可放大预览
- feat(ci): CI 中统一换行符为 LF

## [0.3.0] - 2026-04-21

- feat(core): 会话缓存从 JSON 文件迁移到统一的 SQLite 数据库
- feat(web): 增加基于 SQLite FTS 的会话全文搜索，并在界面中高亮命中片段
- feat(cli): 让实时刷新链路与搜索索引保持同步，确保会话变化后搜索结果及时更新
- docs: 新增 SQLite 存储说明文档，覆盖 schema、索引和数据流
- feat(web): 优化会话详情中的代码格式展示一致性
- docs: 明确时间过滤基于会话活跃时间，而非创建时间

## [0.2.0] - 2026-04-20

- feat(cli): 增加基于文件监听和 SSE 的实时会话刷新
- feat(web): 增加 Dashboard，提供活跃趋势、Agent 分布、最近活动和面包屑导航
- feat(web): 让 Dashboard 与会话列表共享 CLI 时间过滤语义，支持 `--days`、`--from`、`--to`
- feat(core): 优化 Codex 解析与缓存刷新逻辑，增加最近会话重校验
- feat(cli): 服务端保留完整历史数据，同时维持 JSON 输出的时间窗口语义
- fix(api): Dashboard 时间窗口改为基于会话活跃时间统计
- chore: 全量包版本升级到 `0.2.0`，pnpm 升级到 `10.33.0`，并修复跨平台测试路径

## [0.1.5] - 2026-04-16

- fix(cli): 版本号从 `package.json` 动态读取，移除硬编码
- fix(web): 重新构建 web dist，修复页面右上角仍显示 `v0.1.3` 的问题

## [0.1.4] - 2026-04-16

- fix(core): 修复使用缓存扫描结果时未初始化 agent 状态的问题

## [0.1.3] - 2026-04-16

- fix(agents): 过滤 Cursor 中空对话（没有实际消息内容的 composer）
- feat(agents): 为 Claude Code、Codex、Kimi 增加 token 用量追踪
- fix(agents): 优化 Codex 和 Kimi 的时间戳回退逻辑
- feat(web): CLI 输出预览增加带样式的 Agent 状态展示
- feat(web): 构建时从 package.json 注入应用版本号

## [0.1.1] - 2026-04-15

- 修复 Web UI 返回 404 的问题（web dist 路径计算错误）
- 包名从 `agent-lens` 重命名为 `codesesh`

## [0.1.0] - 2025-04-15

- 支持 Claude Code、Cursor、Kimi、Codex、OpenCode 五个 Agent 会话的发现与聚合
- 自动发现本地 Agent 数据目录，零配置启动
- Web UI 统一浏览所有会话，支持按 Agent、目录、时间筛选
- 会话详情页完整回放对话、工具调用、Token 用量和成本
- 缓存 + 增量刷新，秒级启动
