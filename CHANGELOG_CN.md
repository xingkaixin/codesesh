# Changelog

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
