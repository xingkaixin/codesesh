# Changelog

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
