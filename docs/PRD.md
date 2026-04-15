# CodeSesh - 产品需求文档 (PRD)

## 1. 概述

### 1.1 产品定位

CodeSesh 是一个本地 CLI 工具，用于发现、聚合和可视化多种 AI Coding Agent 的本地会话记录。用户通过 `npx codesesh` 或 `bunx codesesh` 一键启动，在浏览器中按 Agent 类型和项目目录分组浏览所有会话，支持日期过滤和多维度筛选。

### 1.2 背景

当前存在两个独立项目：

- **agent-dump** (Python)：从本地文件系统发现并导出 5 种 Coding Agent（Claude Code、Codex、OpenCode、Cursor、Kimi）的会话记录，统一为 JSON 格式
- **agent-view** (React)：将导出的 JSON 会话文件可视化为网页，支持消息时间线、工具输出渲染、TOC 过滤等

CodeSesh 将两者的能力整合为一个 TypeScript monorepo，提供从会话发现到可视化的端到端体验，无需 Python 环境。

### 1.3 目标用户

日常使用多种 AI Coding Agent 的开发者，需要回顾、检索、对比历史会话记录。

---

## 2. 功能需求

### 2.1 CLI 入口

#### 2.1.1 基本用法

```bash
# 无参数：发现所有 Agent 会话，启动 Web UI
npx codesesh

# 指定 Agent
npx codesesh --agent claudecode
npx codesesh --agent codex,cursor

# 指定项目目录
npx codesesh --cwd /path/to/project

# 指定时间范围
npx codesesh --from 2026-04-01 --to 2026-04-15

# 指定具体会话（直接跳转）
npx codesesh --session claude://session-id

# 指定端口
npx codesesh --port 3000

# 仅输出会话索引到 stdout（不启动服务器）
npx codesesh --json
```

#### 2.1.2 控制台输出

CLI 启动时应有结构化的控制台输出：

```
  codesesh v0.1.0

  ◐ Scanning for agent sessions...

  ✔ Claude Code    42 sessions
  ✔ Codex          18 sessions
  ✔ Cursor         35 sessions
  ✖ OpenCode       not found
  ✖ Kimi           not found

  Found 95 sessions across 3 agents

  ➜ http://localhost:4321
```

### 2.2 Web UI

#### 2.2.1 会话浏览

- **一级分组：Agent 类型** - 侧边栏按 Agent 分组展示（Claude Code、Codex、Cursor 等），显示各 Agent 的会话数量
- **二级分组：项目目录 (cwd)** - 选中某个 Agent 后，按工作目录分组展示会话列表
- **会话卡片** - 显示标题、时间、消息数、Token 用量、模型名称

#### 2.2.2 过滤与搜索

- **日期范围过滤** - 在 Web UI 顶部提供日期范围选择器
- **关键词搜索** - 按会话标题模糊搜索
- **Agent 过滤** - 可在 UI 中切换查看特定 Agent

#### 2.2.3 会话详情

复用 agent-view 的会话详情视图：

- 消息时间线（用户/助手/工具调用）
- 工具输出渲染（代码高亮、Diff 视图、结构化输出）
- TOC 侧边栏，按消息类型过滤（文本、推理、工具、计划）
- Token/Cost 统计
- 时间戳显示

### 2.3 支持的 Agent

| Agent | 数据源 | 格式 |
|-------|--------|------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL |
| Codex | `~/.codex/sessions/**/*.jsonl` | JSONL |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite |
| Cursor | `~/Library/Application Support/Cursor/User/workspaceStorage` | SQLite |
| Kimi | `~/.kimi/sessions/**/metadata.json` | JSON + JSONL |

各 Agent 支持环境变量覆盖数据路径，并有平台特定的 fallback 路径。

---

## 3. 技术架构

### 3.1 技术栈

| 层 | 技术选型 | 说明 |
|---|---------|------|
| Monorepo | pnpm workspace + Turborepo | 构建编排 |
| Web | Vite + React + Tailwind CSS + shadcn/ui | 复用 agent-view 组件体系 |
| CLI 参数解析 | citty | TypeScript 原生，轻量，与 consola 配套 |
| CLI 控制台输出 | consola | 彩色日志、spinner、结构化输出 |
| HTTP 服务器 | Hono + @hono/node-server | 轻量、TypeScript 优先 |
| SQLite 读取 | better-sqlite3 | 同步 API，用于 OpenCode 和 Cursor |
| 构建打包 | tsup（CLI/Core）+ Vite（Web） | CLI 打包为单文件 ESM |
| 浏览器打开 | open | 跨平台 |

### 3.2 Monorepo 结构

```
codesesh/
├── pnpm-workspace.yaml
├── turbo.json
├── package.json                 # root scripts, devDeps
├── tsconfig.base.json
│
├── packages/
│   ├── core/                    # @codesesh/core
│   │   └── src/
│   │       ├── types/           # 统一类型定义
│   │       │   ├── session.ts   # SessionHead, SessionData, Message, MessagePart
│   │       │   ├── agent.ts     # AgentInfo, ScanOptions
│   │       │   └── filters.ts   # FilterOptions
│   │       ├── agents/          # 各 Agent 适配器
│   │       │   ├── base.ts      # BaseAgent 抽象类
│   │       │   ├── registry.ts  # Agent 注册表
│   │       │   ├── claudecode.ts
│   │       │   ├── codex.ts
│   │       │   ├── opencode.ts
│   │       │   ├── cursor.ts
│   │       │   └── kimi.ts
│   │       ├── discovery/       # 会话发现
│   │       │   ├── scanner.ts   # AgentScanner
│   │       │   └── paths.ts     # 平台路径解析
│   │       └── utils/           # 工具函数
│   │           ├── jsonl.ts
│   │           └── sqlite.ts
│   │
│   └── cli/                     # @codesesh/cli（npm bin: codesesh）
│       └── src/
│           ├── index.ts         # CLI 入口
│           ├── commands/
│           │   └── serve.ts     # 默认命令：发现 + 启动服务
│           ├── server.ts        # Hono HTTP 服务器
│           ├── api/
│           │   ├── routes.ts    # API 路由定义
│           │   └── handlers.ts  # 请求处理器
│           └── output.ts        # 控制台输出格式化
│
└── apps/
    └── web/                     # @codesesh/web
        ├── vite.config.ts
        ├── index.html
        └── src/
            ├── App.tsx          # 基于 agent-view 改造
            ├── components/      # 从 agent-view 移植
            ├── config.ts        # Agent 配置
            └── lib/
                └── api.ts       # API 客户端
```

### 3.3 数据流

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   本地文件    │────▶│  Core 适配器  │────▶│  CLI 服务器   │
│ JSONL/SQLite │     │  发现 + 转换  │     │  Hono API    │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                │ HTTP
                                         ┌──────▼───────┐
                                         │   Web UI     │
                                         │  React SPA   │
                                         └──────────────┘
```

1. **发现阶段**（Core）：Scanner 遍历所有已注册的 Agent 适配器，调用 `isAvailable()` 和 `scan()` 收集 `SessionHead`（轻量元数据：id、title、cwd、时间、消息数）
2. **服务阶段**（CLI）：启动 Hono HTTP 服务器，暴露 API 并托管 Web 静态资源
3. **展示阶段**（Web）：SPA 通过 API 获取会话列表和详情，按需加载完整消息数据

### 3.4 API 设计

```
GET /api/agents
  → [{ name, displayName, count, icon }]

GET /api/sessions?agent=X&cwd=Y&from=Z&to=W&q=keyword
  → { sessions: SessionHead[] }

GET /api/sessions/:agent/:sessionId
  → SessionData（含完整 messages）
```

会话列表只返回元数据，完整消息数据按需加载，避免一次性传输大量数据。

### 3.5 核心类型

```typescript
// 会话元数据（列表展示用）
interface SessionHead {
  id: string;
  agent: string;            // "claudecode" | "codex" | "opencode" | "cursor" | "kimi"
  agentDisplayName: string;
  title: string;
  cwd: string;
  createdAt: number;        // ms epoch
  updatedAt: number;
  model?: string;
  messageCount?: number;
}

// 完整会话数据（详情展示用）
interface SessionData {
  id: string;
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated?: number;
  stats: SessionStats;
  messages: Message[];
}

// Agent 适配器接口
abstract class BaseAgent {
  abstract name: string;
  abstract displayName: string;
  abstract isAvailable(): Promise<boolean>;
  abstract scan(options?: ScanOptions): Promise<SessionHead[]>;
  abstract getSessionData(sessionId: string): Promise<SessionData>;
}
```

消息和消息片段类型（Message、MessagePart）复用 agent-view 已有定义。

### 3.6 构建与发布

**构建顺序**（Turborepo 管理依赖）：

1. `@codesesh/core` → tsc 编译
2. `@codesesh/web` → vite build（依赖 core 类型）
3. `@codesesh/cli` → tsup 打包（依赖 core；将 web dist 嵌入到产物中）

**发布**：

仅发布 `codesesh` CLI 包到 npm。CLI 包内嵌 Web 构建产物，用户 `npx codesesh` 即可使用，无需额外安装。

```json
{
  "name": "codesesh",
  "bin": { "codesesh": "dist/cli.mjs" },
  "files": ["dist/"],
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0"
  }
}
```

---

## 4. 里程碑

### M1: 项目骨架

- Monorepo 初始化（pnpm workspace、Turborepo、共享 tsconfig）
- Core 包：类型定义、BaseAgent 抽象类、Agent 注册表、Scanner
- CLI 包：基本参数解析、控制台输出、Hono 服务器骨架
- Web 包：Vite + React + Tailwind + shadcn 初始化

### M2: Claude Code 适配器

- 移植 claudecode.py 的会话发现和格式转换逻辑
- API 端对端联通：CLI → Core → Web
- Web UI 基础布局：Agent 分组侧边栏 + 会话列表

### M3: 会话详情视图

- 从 agent-view 移植核心组件（SessionDetail、ToolOutputRenderer、MarkdownContent）
- 消息时间线渲染、TOC 过滤

### M4: 全 Agent 支持

- 移植 Codex、OpenCode、Cursor、Kimi 适配器
- 按 cwd 分组展示
- 日期范围过滤

### M5: 打磨与发布

- CLI 参数完善（--agent、--cwd、--from、--to、--session、--json）
- 控制台输出美化
- npm 发布流程
- 错误处理与边界情况

---

## 5. 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 数据传递方式 | API 服务器（Hono） | 按需加载，服务端过滤，与 agent-view 的 fetch 模式一致 |
| 适配器位置 | 放在 `packages/core` | 与类型和发现逻辑紧密耦合，分离会导致循环依赖 |
| CLI 参数解析 | citty | TypeScript 原生，轻量，与 consola 配套 |
| SQLite 库 | better-sqlite3 | 同步 API，性能好，OpenCode 和 Cursor 需要 |
| Web 嵌入方式 | 构建时复制到 CLI dist | `npx` 一键可用，无需额外安装 |
| 不单独拆分 converter 包 | 转换逻辑留在各 Agent 适配器内 | 转换逻辑与各 Agent 的原始格式强耦合，Python 版也是如此 |

---

## 6. 非功能性需求

- **启动速度**：CLI 从启动到浏览器打开应在 3 秒内
- **内存效率**：会话列表只加载元数据，完整数据按需加载
- **跨平台**：支持 macOS、Linux、Windows（路径解析需适配）
- **零配置**：无参数即可使用，自动发现所有已安装 Agent 的会话
