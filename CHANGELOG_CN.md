# Changelog

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
