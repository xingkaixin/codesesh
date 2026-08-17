# CodeSesh

**用途**：发现、聚合、可视化受支持的本地 AI 编码 Agent 历史会话，通过 Web UI 统一浏览。

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

## 验证

一条命令的整体检查：`pnpm lint && pnpm typecheck && pnpm build && pnpm test`。

- `pnpm typecheck`：全 workspace 类型检查（web 单独跑最快：`pnpm --filter @codesesh/web typecheck`）。
- `pnpm test`：turbo 单测；单包用 `pnpm --filter <pkg> test`。
- `pnpm test:coverage`：先跑 `scripts/critical-coverage.mjs` 的覆盖率 ratchet（按 scope 设阈值，低于阈值即红），再全量覆盖率。
- `pnpm --filter @codesesh/web test:bundle`：初始 bundle 300KB gzip 预算（`apps/web/tests/initial-bundle.test.ts`），需先 `pnpm build`；随手一个顶层 import 就可能触发。
- `pnpm test:e2e`：Playwright 端到端（`tests/e2e/`），需要先构建。
- `pnpm test:migration`：SQLite 缓存 schema 迁移冒烟。

CI（`.github/workflows/ci.yml`）在以上之外还前置这些门禁，本地提前跑可避免红管线往返：

- `node scripts/check-quality-task-coverage.mjs`：每个包必须声明 lint/format/typecheck 等质量脚本。
- `node scripts/check-docs-paths.mjs`：文档（含本文件）引用的路径必须真实存在。
- `node scripts/check-docs-facts.mjs`：README 等文档中的 repo-fact 标记块（CI 命令清单、schema 版本号等）必须与源码一致——改了 `CACHE_SCHEMA_VERSION` 或 CI 步骤要同步改文档。
- `node scripts/release-preflight.mjs`：包版本一致性。
- `pnpm perf:check`：算法增长率检查。

## 扩展新 Agent

1. 在 `packages/core/src/agents/` 新增适配器并导出数据根目录解析器。
2. 在 `packages/core/src/contract/agent-catalog.ts` 声明公开身份、图标、来源类型、resume 命令能力与工具展示策略。
3. 在 `packages/core/src/agents/register.ts` 添加工厂与数据根目录解析器。
4. 在 `apps/web/public/icon/agent/` 与 `apps/www/public/icon/agent/` 添加对应 SVG。
5. 自定义工具展示需新增 `apps/web/src/components/session-detail/tool-strategy/<agent>.ts`
   并在同目录的 `apps/web/src/components/session-detail/tool-strategy/index.ts` 注册 builder；使用默认策略则无需新增实现。

注册完备性测试必须覆盖图标与工具展示策略声明。
