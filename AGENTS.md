# CodeSesh

**用途**：发现、聚合、可视化本地 AI 编码 Agent（Claude Code、Cursor、Kimi、Codex、OpenCode）的历史会话，通过 Web UI 统一浏览。

## 技术栈

- **Monorepo**：pnpm + Turbo
- **语言**：TypeScript 5.x，tsup 打包
- **Server**：Hono（HTTP API）+ Citty（CLI 解析）
- **Web**：React 19 + React Router + Tailwind CSS 4 + Radix UI
- **Lint**：oxlint
- **Format**：oxfmt
- **Test**：vitest + @vitest/coverage-v8

## 包结构与模块职能

```
packages/core       核心库（framework-agnostic）
  agents/           各 Agent 适配器（base / registry / register + 各实现）
  discovery/        会话路径解析 & 文件扫描（paths.ts / scanner.ts）
  types/            共享类型定义
  utils/            工具函数

packages/cli        CLI 入口 & HTTP 服务器
  index.ts          命令解析，驱动扫描 → 启动服务器
  server.ts         Hono 服务，暴露 JSON API
  api/              API 端点定义
  commands/         CLI 子命令

apps/web            React 前端
  App.tsx           路由 & 顶层状态
  components/       UI 组件
  lib/              HTTP API 调用 & 工具
  config.ts         前端配置（API 地址等）
```

## 数据流

```
CLI 参数 → core 扫描会话 → Hono HTTP API → React Web UI 展示
```

## 扩展新 Agent

在 `packages/core/src/agents/` 新增适配器文件，并在 `register.ts` 中导入注册即可，无需改动其他模块。
