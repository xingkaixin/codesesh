# Changelog

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
