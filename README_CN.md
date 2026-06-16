
# CodeSesh

<p align="center">
  <img src="assets/codesesh-logo-kinetic.svg" alt="CodeSesh Logo" width="128" height="128">
</p>

> **一个地方，看遍你所有的 AI 编程会话。**

你一直在用 AI Agent 写代码 —— Claude Code、Cursor、Kimi、Codex、Pi、OpenCode —— 但这些对话分散在文件系统的各个角落。上下文丢失，成本不可见，历史深埋。

**CodeSesh** 解决这个问题。它扫描你的本地机器，找到所有 AI Agent 会话，并在统一的 Web UI 中呈现。把它理解为你 AI 辅助开发历程的时光机。

---

## 为什么选择 CodeSesh？

现代开发者同时使用多个 AI 编程工具。每个工具都以自己的私有格式、存储在自己的隐藏目录中保存会话历史。没有办法跨工具搜索、比较成本，或重温三周前那段精彩的对话。

CodeSesh 认为，你的会话历史属于**你** —— 你应该在一个地方看到全部。

**你能得到什么：**

- **统一时间线** —— 在单一可搜索界面中浏览所有 AI Agent 的会话
- **结构化全局搜索** —— 按标题、消息、工具输出和文件路径检索，并按 Agent、项目、智能标签、工具、文件活动和成本筛选
- **Dashboard 与活跃趋势** —— 一眼看到每日活跃、Agent 分布、最近会话、最新活动时间、Token 用量、模型用量、智能标签和成本
- **项目浏览模式** —— 打开独立项目视图，查看项目级指标、会话和跨 Agent 下钻
- **项目会话树** —— 按仓库或项目身份聚合所有支持 Agent 的会话
- **智能标签** —— 自动标注修复、重构、功能开发、测试、文档、规划、Git 操作、构建发布和探索类会话
- **会话收藏** —— 收藏重要会话，并在 Dashboard 中快速回看
- **完整对话回放** —— 原样回放每一条消息、工具调用和推理步骤
- **文件活动索引** —— 跳转到被读取、编辑、创建、删除或移动的文件，并按文件活动搜索会话
- **键盘导航** —— 通过快捷键切换视图、聚焦搜索、打开快捷键面板
- **Agent 恢复命令复制** —— 在受支持 Agent 的会话详情中复制兼容 worktree 的恢复命令
- **成本与 Token 可见** —— 查看 Token 总量、缓存 Token、记录成本和基于模型价格的估算成本
- **SQLite 缓存、迁移与搜索索引** —— 快速恢复会话列表，安全升级本地 schema，并复用同一个本地搜索存储
- **零配置** —— 直接运行，CodeSesh 自动发现文件系统上的一切
- **100% 本地私有** —— 数据留在你的机器上，无账号、无云同步、无云端遥测
- **实时刷新** —— 本地会话变化会自动同步到界面，无需重启

---

## 支持的 Agent

| Agent | 状态 |
|-------|------|
| Claude Code | 已支持 |
| Cursor | 已支持 |
| Kimi | 已支持 |
| Codex | 已支持 |
| Pi | 已支持 |
| OpenCode | 已支持 |

更多 Agent 持续接入中。添加新 Agent [只需一个文件](#扩展新-agent)。

---

## 快速开始

### 环境要求

- 发布后的 CLI 需要 Node.js 18+
- 源码构建需要 Node.js 24 和 pnpm 11.5.1

### 安装与运行

```bash
# 运行已发布的 CLI
npx codesesh
```

浏览器会自动打开 `http://localhost:4521`，你的所有会话已就绪。如果默认端口被占用，CodeSesh 会自动尝试下一个可用端口。

### 从源码构建

```bash
git clone https://github.com/xingkaixin/codesesh.git
cd codesesh

pnpm install
pnpm build
pnpm serve
```

本地服务使用 `packages/cli/dist/index.js`，打开同一个 Web UI。

---

## 使用方式

### 基础用法

```bash
# 启动 Web UI（默认端口 4521）
npx codesesh

# 自定义起始端口
npx codesesh --port 8080
npx codesesh -p 8080

# 启动但不自动打开浏览器
npx codesesh --no-open
```

### 按时间筛选

```bash
# 只显示最近 3 天内有活动的会话
npx codesesh --days 3

# 显示全部会话（不限时间）
npx codesesh --days 0

# 显示指定日期之后有活动的会话（覆盖 --days）
npx codesesh --from 2025-01-01

# 显示某个日期范围内的会话
npx codesesh --from 2025-01-01 --to 2025-03-31
```

### 按目录筛选

```bash
# 只显示当前项目的会话
npx codesesh --cwd .

# 只显示指定路径的会话
npx codesesh --cwd /Users/you/projects/my-app
```

### 按 Agent 筛选

```bash
# 只显示 Claude Code 的会话
npx codesesh --agent claudecode

# 只显示 Cursor 的会话
npx codesesh --agent cursor

# 多个 Agent，用逗号分隔
npx codesesh --agent claudecode,cursor
```

### 直接打开指定会话

```bash
# 通过 Agent 和 ID 直接跳转到某个会话
npx codesesh --session claudecode://3b0e4ead-eba9-43e7-9fac-b30647e189f8
```

### JSON 输出（用于脚本）

```bash
# 以 JSON 格式输出所有会话数据，不启动服务器
npx codesesh --json
npx codesesh -j
```

### CLI 参数一览

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--port` | `-p` | `4521` | HTTP 服务器起始端口；被占用时自动尝试下一个可用端口 |
| `--days` | `-d` | `7` | 只包含最近 N 天内有活动的会话（`0` = 全部） |
| `--cwd` | — | — | 筛选指定项目目录（`.` = 当前目录） |
| `--agent` | `-a` | 全部 | 筛选指定 Agent，逗号分隔 |
| `--from` | — | — | 指定日期之后有活动的会话 `YYYY-MM-DD`（覆盖 `--days`） |
| `--to` | — | — | 指定日期之前有活动的会话 `YYYY-MM-DD` |
| `--session` | `-s` | — | 直接打开某个会话（`agent://session-id`） |
| `--json` | `-j` | `false` | 输出 JSON 后退出（不启动服务器） |
| `--no-open` | — | `false` | 不自动打开浏览器 |
| `--trace` | — | `false` | 打印性能追踪日志 |
| `--cache` | — | `true` | 优先使用缓存扫描结果 |
| `--clear-cache` | — | `false` | 启动前清空扫描缓存 |
| `-v` | — | — | 打印版本号 |
| `-h` / `--help` | — | — | 显示帮助信息 |

---

## Web UI 说明

CodeSesh 启动后，你将看到：

1. **Dashboard** —— 总会话数、总消息数、总 Token、最新活动、每日活跃趋势、Agent 分布、模型分布、Token 趋势、智能标签、收藏会话和最近会话
2. **结构化全局搜索** —— 检索标题、消息、工具输出和文件路径，并按 Agent、项目、标签、工具、文件活动或成本缩小范围
3. **项目视图** —— 查看项目总量、最近活动、Agent 构成、项目级 Dashboard 和单个仓库或项目身份下的会话
4. **会话树侧边栏** —— 按 Agent 或项目身份浏览会话，并按 Agent 或智能标签筛选
5. **会话列表** —— 按最新时间排序浏览会话，每张卡片显示标题、工作目录、消息数和总成本
6. **智能标签与会话收藏** —— 快速识别会话意图，固定需要反复查看的会话，并在 Dashboard 或会话视图中管理
7. **会话详情** —— 点击任意会话查看完整回放，包括 receipt 摘要、用户消息、Assistant 回复、工具调用、推理步骤、模型标签、文件活动和 Agent 恢复命令复制
8. **快捷键** —— 通过快捷键面板查看导航、全局搜索、聚焦搜索和分组跳转操作
9. **实时同步** —— 服务运行期间，本地新增或更新的会话会自动反映到界面

---

## 开发

```bash
# 构建所有包
pnpm build

# 清理构建产物
pnpm clean

# Lint
pnpm lint
pnpm lint:fix

# 格式化
pnpm format
pnpm format:check

# 测试
pnpm test
pnpm test:watch
pnpm test:coverage

# 性能 benchmark
pnpm bench:perf

# 部署落地页到 Cloudflare Pages
pnpm --filter @codesesh/www deploy:cf
```

### 性能 Benchmark

```bash
# 使用 warm cache，对自动选择的代表性会话跑 benchmark
pnpm bench:perf -- --days 0 --iterations 3

# 启用 cold start 和 React 渲染 profile
pnpm bench:perf -- --cold --react-profile --target heaviest --navigation direct
```

### 开发模式（监听变更）

开两个终端：

```bash
# 终端 1 — 监听源码变更并重新编译
pnpm dev

# 终端 2 — dist 变更时自动重启服务器
pnpm serve

# 或直接传入 CLI 参数：
node --watch packages/cli/dist/index.js --cwd . --days 3
```

### 项目结构

```
packages/core       核心库（framework-agnostic）
  agents/           各 Agent 适配器（每个 Agent 一个文件）
  discovery/        会话路径解析 & 文件扫描
  types/            共享 TypeScript 类型定义
  utils/            工具函数

packages/cli        CLI 入口 & HTTP 服务器
  src/commands/     CLI 子命令
  src/api/          Hono 路由处理器

apps/web            React 前端
  src/components/   UI 组件
  src/lib/          API 客户端 & 工具函数
```

### 扩展新 Agent

添加对新 AI Agent 的支持只需一个文件：

1. 创建 `packages/core/src/agents/youragent.ts`，实现 `BaseAgent` 接口
2. 在 `packages/core/src/agents/register.ts` 中注册

无需改动其他任何文件，该 Agent 会立即出现在 UI 中。
