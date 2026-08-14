# CodeSesh

**用途**：发现、聚合、可视化本地 AI 编码 Agent（Claude Code、Cursor、Kimi、Kimi-Code、Codex、Grok、Pi、OpenCode、ZCode、DSH）的历史会话，通过 Web UI 统一浏览。

## 技术栈

- **Monorepo**：pnpm（版本以 `package.json` 的 `packageManager` 字段为准）+ Turbo
- **语言**：TypeScript 7（`tsc` 原生）+ TypeScript 6（`typescript` API / `tsc6`，供 tsup d.ts、Astro 等），tsup 打包
- **Server**：Hono（HTTP API）+ Citty（CLI 解析）
- **Web**：React 19 + React Router + Tailwind CSS 4 + Base UI
- **Lint**：oxlint
- **Format**：oxfmt
- **Test**：vitest + @vitest/coverage-v8

## 包结构与模块职能

- `packages/core/src/`：framework-agnostic 核心库
  - `packages/core/src/agents/`：各 Agent 适配器、注册表与能力声明
  - `packages/core/src/analytics/`：Dashboard 与项目聚合统计
  - `packages/core/src/bookmarks/`：书签物化
  - `packages/core/src/contract/`：前后端共享的 browser-safe 契约
  - `packages/core/src/discovery/`：扫描编排、路径解析与 Session Detail 加载
  - `packages/core/src/discovery/cache/`：Session 缓存与搜索索引持久化
  - `packages/core/src/pricing/`：模型定价、代际同步与成本计算
  - `packages/core/src/projects/`：Project Identity、分组与作用域匹配
  - `packages/core/src/search/`：Session 搜索
  - `packages/core/src/state/`：书签、别名等用户状态
  - `packages/core/src/types/`：共享类型定义
  - `packages/core/src/utils/`：通用工具函数
- `packages/cli/src/`：CLI 入口、HTTP 服务与后台 Worker
  - `packages/cli/src/index.ts`：参数解析，驱动扫描并启动服务器
  - `packages/cli/src/server.ts`：Hono 服务与生命周期管理
  - `packages/cli/src/api/`：HTTP API 端点；其余扫描、索引与 Worker 模块保持扁平布局
- `apps/web/src/`：React 应用
  - `apps/web/src/App.tsx`：路由与顶层状态
  - `apps/web/src/components/`：产品与 UI 组件
  - `apps/web/src/hooks/`：客户端状态与数据同步 hooks
  - `apps/web/src/lib/`：HTTP API 客户端与前端工具
  - `apps/web/src/styles/`：全局样式
- `apps/www/`：Astro 产品站
  - `apps/www/src/pages/`：静态页面路由
  - `apps/www/src/components/`：产品站组件
  - `apps/www/public/`：静态资源

## 数据流

```
CLI 参数 → core 全量扫描 / 缓存恢复 → LiveScanStore 文件监听增量刷新 → Hono HTTP API / SSE → React Web UI（Dashboard / 会话列表 / 详情）
```

## 扩展新 Agent

1. 在 `packages/core/src/agents/` 新增适配器并导出数据根目录解析器。
2. 在 `packages/core/src/agents/register.ts` 注册图标、根目录解析器、resume 命令能力（不支持时显式为
   `null`）与工具展示策略类型。
3. 在 `apps/web/public/icon/agent/` 添加对应 SVG。
4. 自定义工具展示需新增 `apps/web/src/components/session-detail/tool-strategy/<agent>.ts`
   并在同目录的 `apps/web/src/components/session-detail/tool-strategy/index.ts` 注册 builder；使用默认策略则无需新增实现。

注册完备性测试必须覆盖图标与工具展示策略声明。
