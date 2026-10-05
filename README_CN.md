
# CodeSesh

<p align="center">
  <img src="assets/codesesh-logo-kinetic.svg" alt="CodeSesh Logo" width="128" height="128">
</p>

> **一个地方，看遍你所有的 AI 编程会话。**

你一直在用 AI Agent 写代码，但这些对话分散在文件系统的各个角落。上下文丢失，成本不可见，历史深埋。

**CodeSesh** 解决这个问题。它扫描你的本地机器，找到所有 AI Agent 会话，并在统一的 Web UI 中呈现。把它理解为你 AI 辅助开发历程的时光机。

---

## 为什么选择 CodeSesh？

现代开发者同时使用多个 AI 编程工具。每个工具都以自己的私有格式、存储在自己的隐藏目录中保存会话历史。没有办法跨工具搜索、比较成本，或重温三周前那段精彩的对话。

CodeSesh 认为，你的会话历史属于**你** —— 你应该在一个地方看到全部。

**你能得到什么：**

- **统一时间线** —— 在单一可搜索界面中浏览所有 AI Agent 的会话
- **灵活时间范围** —— 无需重启服务，即可切换滚动时间预设、全部历史或自定义日期范围
- **会话别名** —— 为重要会话设置易记的本地名称，并在搜索、收藏和活动视图中统一使用
- **持久化主题** —— 选择浅色、深色或跟随系统外观，并在不同会话之间保留 UI 偏好
- **结构化全局搜索** —— 按标题、消息、工具输出和文件路径检索，并按 Agent、项目、智能标签、工具、文件活动和成本筛选。支持中文子串匹配，从消息结果直接定位到首条命中消息
- **界面语言** —— 支持简体中文、英文和日文，默认跟随浏览器语言。可在顶部工具栏手动切换并记住选择；会话原文与代码保持不变。
- **Dashboard 与活跃趋势** —— 一眼看到每日活跃、Agent 分布、最近会话、最新活动时间、Token 用量、所选日期范围内的模型 Token 占比、智能标签和成本
- **项目浏览模式** —— 打开独立项目视图，查看项目级指标、会话和跨 Agent 下钻
- **项目与嵌套会话树** —— 按仓库或项目身份组织会话，并将子 Agent 会话保留在父会话下
- **智能标签** —— 自动标注修复、重构、功能开发、测试、文档、规划、Git 操作、构建发布和探索类会话
- **会话收藏** —— 收藏重要会话，并在 Dashboard 中快速回看
- **完整对话回放** —— 分页阅读消息、工具调用和推理，也可加载完整对话。保留阅读位置，支持复制完整 Markdown
- **文件活动索引** —— 跳转到被读取、编辑、创建、删除或移动的文件，并按文件活动搜索会话
- **键盘导航** —— 通过快捷键切换视图、聚焦搜索、打开快捷键面板
- **Agent 恢复命令复制** —— 在受支持 Agent 的会话详情中复制兼容 worktree 的恢复命令，并确认来源机器与命令运行位置
- **可恢复的历史索引** —— 为大型回填保存检查点，中断后可继续，并显示持久化进度
- **成本与 Token 可见** —— 查看 Token 总量、缓存 Token、记录成本和基于模型价格的估算成本
- **会话收据** —— 按模型和 Token 类别核对用量及可用费用明细，并将完整收据导出为 PNG
- **SQLite 缓存、迁移与搜索索引** —— 快速恢复会话列表，安全升级本地 schema，并复用同一个本地搜索存储
- **零配置** —— 直接运行，CodeSesh 自动发现文件系统上的一切
- **默认本地运行** —— 单机历史留在本机；可选 Worker 会将会话发送到你自托管的 Hub，无需账号或云端遥测
- **实时刷新** —— 本地会话变化会自动同步到界面，无需重启

---

## 使用 Hub 与 Worker 汇总多台机器

运行 `codesesh hub` 提供只负责查询的 Web UI，在需要采集的机器上配对独立的 `codesesh worker`。来源节点面板提供配对引导、采集健康状态、重采集和 Worker 替换管理。macOS、Linux 与 Windows 均提供用户级后台服务命令。部署、迁移和恢复步骤见 [Hub/Worker 指南](docs/hub-worker.md)。

## 支持的 Agent

<!-- repo-fact:agents:start -->

| Agent       | 状态   |
| ----------- | ------ |
| Claude Code | 已支持 |
| Cursor      | 已支持 |
| Kimi-Cli    | 已支持 |
| Kimi-Code   | 已支持 |
| Codex       | 已支持 |
| Grok        | 已支持 |
| Pi          | 已支持 |
| OpenCode    | 已支持 |
| ZCode       | 已支持 |
| DSH         | 已支持 |
| DeepChat    | 已支持 |
| Cherry Studio | 已支持 |
| MiniMax Code | 已支持 |
| Antigravity CLI | 部分支持 |

<!-- repo-fact:agents:end -->

Antigravity CLI 支持本地 SQLite 对话、标题、工作区信息及工具调用。工具结果与用量仍为未知，暂不支持 IDE `.pb` 历史。详情见[兼容说明](docs/antigravity-cli-integration.md)。

OpenCode 支持 V1 SQLite 历史与 V2 `2.0.15` 数据结构。可通过 `OPENCODE_DB` 指定自定义数据库，相对路径基于 `XDG_DATA_HOME/opencode`，默认目录为 `~/.local/share/opencode`。V2 迁移完成后开始读取；费用采用会话累计值，避免重复计算 fork 复制的历史。支持内容及验证边界见 [兼容设计](docs/opencode-v2-integration.md)。

MiniMax Code 支持 CLI 0.4.12 的 `v2/sqlite/runtime-state.sqlite`，包含会话树、思考、工具调用和用量。默认依次查找 `~/.minimax`、`~/.minimax-code`，选择首个存在数据库的目录；`MINIMAX_DATA_DIR` 优先于 `MAVIS_DATA_DIR`。同步会识别已有消息的修改和删除，不限于追加消息。媒体仅展示可用引用；旧 ledger 布局和 Desktop 兼容性未验证。详情见 [接入设计](docs/minimax-code-integration.md)。

DeepChat 支持新版未加密的 `app_db/agent.db`，包含原生及 ACP 会话。
可通过 `DEEPCHAT_USER_DATA_DIR` 指定用户数据目录。
旧版 `chat.db`、SQLCipher 加密库和恢复会话命令暂不支持。
ACP 会话按 DeepChat 来源统计，不与外部 Agent 的原始记录自动去重。

Cherry Studio 支持 2.x 的 `Data/cherrystudio.sqlite`，包含 Agent 会话（Claude Code、Pi、DSH）
和普通助手聊天的当前分支。聊天消息及用量按当前分支统计，不包含其他候选回复。
普通聊天按用户数据目录分组，Agent 会话保留工作目录。自定义或便携版数据目录可通过
`CHERRYSTUDIO_USER_DATA_DIR` 指定。用量读取 Cherry 已汇总的消息统计，避免重复累计。
美元费用保留原值；其他币种在有模型定价时估算美元费用。旧版 1.x 的 `agents.db`、
独立子 Agent 会话树及恢复会话命令暂不支持。会话统一归属 Cherry Studio，不跨 Agent 去重。

更多 Agent 持续接入中。参见[扩展清单](#扩展新-agent)。

---

## 快速开始

### 环境要求

<!-- repo-fact:node-version:start -->

- npm launcher 需要 Node.js 22+；独立原生可执行文件不需要 Node。
  源码构建使用 `mise.toml` 固定的 Node 24 和 `rust-toolchain.toml` 固定的 Rust 工具链。

<!-- repo-fact:node-version:end -->

<!-- repo-fact:pnpm-version:start -->

- 源码构建需要 pnpm 12.4.2

<!-- repo-fact:pnpm-version:end -->

原生目标为 macOS arm64/x64、Linux x64 GNU 和 Windows x64。Linux 最低要求 **glibc 2.35**，
CI 与 release 验收固定使用 Ubuntu 22.04；首版不支持更旧 glibc、musl 或 Linux arm64。

### 安装与运行

```bash
# 运行已发布的 CLI
npx codesesh
```

浏览器会自动打开 `http://localhost:4521`，你的所有会话已就绪。如果默认端口被占用，CodeSesh 会自动尝试下一个可用端口。

### 原生安装（无需 Node.js）

macOS / Linux x64（glibc 2.35+）：

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | sh
codesesh
```

默认安装到 `~/.local/bin`。再次运行安装命令即可更新。指定版本或安装目录：

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | CODESESH_VERSION=1.1.1 CODESESH_INSTALL_DIR="$HOME/.local/bin" sh
```

macOS（Homebrew）：

```sh
brew install xingkaixin/tap/codesesh
codesesh
# 更新
brew upgrade codesesh
```

Windows x64（先安装 Scoop）：

```powershell
scoop bucket add xingkaixin https://github.com/xingkaixin/scoop-bucket
scoop install xingkaixin/codesesh
codesesh
# 更新
scoop update codesesh
```

更新前停止正在运行的 CodeSesh，更新后重新启动。各渠道独立管理；如果安装过多个渠道，
请检查 PATH 中实际使用的命令。安装脚本不修改 shell 配置，也不覆盖符号链接。
卸载使用 `brew uninstall codesesh`、`scoop uninstall codesesh`，或删除 curl 安装目录中的
`codesesh` 文件；用户配置和索引保留。

### 从源码构建

```bash
git clone https://github.com/xingkaixin/codesesh.git
cd codesesh

pnpm install
pnpm build
pnpm serve
```

本地服务运行 Rust 可执行文件和内嵌 Web UI。release 编译前需要先构建 Web；
`pnpm build` 负责仓库构建流程。

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
# 以 JSON 格式输出会话索引，不启动服务器
npx codesesh --json
npx codesesh -j
```

输出是索引而非归档：包含 `agents` 摘要与 `sessions` 数组（id、slug、标题、目录、项目身份、
时间戳、token/成本统计与智能标签），**不包含**消息、工具调用、推理过程与文件活动，因此
不能作为历史记录的备份。会话内容仍保存在各 Agent 自己的数据目录中。

### CLI 参数一览

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--port` | `-p` | `4521` | HTTP 服务器起始端口；被占用时自动尝试下一个可用端口 |
| `--host` | — | `127.0.0.1` | HTTP 服务器绑定地址；默认仅限本机，显式设置为 `0.0.0.0` 等地址可开放网络访问 |
| `--remote-access` | — | `false` | 为非回环 `--host` 启用 token 保护；持有启动 URL 的任何人都能读取会话数据 |
| `--days` | `-d` | `7` | 只包含最近 N 天内有活动的会话（`0` = 全部） |
| `--cwd` | — | — | 筛选指定项目目录（`.` = 当前目录） |
| `--agent` | `-a` | 全部 | 筛选指定 Agent，逗号分隔 |
| `--from` | — | — | 指定日期之后有活动的会话 `YYYY-MM-DD`（覆盖 `--days`） |
| `--to` | — | — | 指定日期之前有活动的会话 `YYYY-MM-DD` |
| `--session` | `-s` | — | 直接打开某个会话（`agent://session-id`） |
| `--json` | `-j` | `false` | 输出会话索引 JSON 后退出（仅元数据，不含消息） |
| `--no-open` | — | `false` | 不自动打开浏览器 |
| `--trace` | — | `false` | 打印性能追踪日志 |
| `--cache` | — | `true` | 优先使用缓存扫描结果 |
| `--clear-cache` | — | `false` | 启动前清空扫描缓存 |
| `-v` | — | — | 打印版本号 |
| `-h` / `--help` | — | — | 显示帮助信息 |

非回环地址必须同时启用 `--remote-access`，否则 CodeSesh 会拒绝启动。每次进程启动都会
生成新的访问 token，并将其包含在输出 URL 中。请将该 URL 视为密码，不要公开或保存到
共享的 shell 历史记录中。

模型估算价格来自 [models.dev](https://models.dev/api.json)，缓存在 `~/.codesesh/models-dev-pricing.json`，有效期为 1 小时。启动时复用有效缓存；缓存过期或缺失时，在扫描前刷新，最多等待 10 秒。网络失败时继续使用旧缓存或内置价格。新模型定价可用后，后续扫描会重新计算此前缺少定价的会话。

---

## Web UI 说明

CodeSesh 启动后，你将看到：

1. **Dashboard** —— 总会话数、总消息数、总 Token、最新活动、每日活跃趋势、Agent 分布、所选日期范围内的模型 Token 占比、Token 趋势、智能标签、收藏会话和最近会话
2. **结构化全局搜索** —— 检索标题、消息、工具输出和文件路径，并按 Agent、项目、标签、工具、文件活动或成本缩小范围
3. **项目视图** —— 查看项目总量、最近活动、Agent 构成、项目级 Dashboard 和单个仓库或项目身份下的会话
4. **会话树侧边栏** —— 按 Agent 或项目身份浏览会话，将嵌套子 Agent 会话保留在父会话下，并按 Agent 或智能标签筛选
5. **时间范围控制** —— 通过滚动时间预设、全部历史或自定义日期范围筛选整个 Web UI
6. **会话列表** —— 按最新时间排序浏览会话，每张卡片显示标题、工作目录、消息数和总成本
7. **会话别名、智能标签与收藏** —— 在本地重命名会话、快速识别会话意图，并固定需要反复查看的内容
8. **会话详情** —— 点击任意会话查看完整回放，包括 receipt 摘要、用户消息、Assistant 回复、工具调用、推理步骤、模型标签、文件活动和 Agent 恢复命令复制
9. **快捷键** —— 通过快捷键面板查看导航、全局搜索、聚焦搜索和分组跳转操作
10. **实时同步** —— 服务运行期间，本地新增或更新的会话会自动反映到界面

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

# 部署落地页到 Cloudflare Workers
pnpm deploy:www
```

Rust 后端通过 Cargo 测试。`test:coverage` 统计 Vitest 覆盖的 TypeScript 契约和 Web 代码，
不代表 Rust 覆盖率。Playwright 使用原生服务器验证浏览器流程；后端进程契约和固定 Node
参考制品提供独立的兼容性检查。

落地页部署到 `codesesh` Worker，正式域名为 `codesesh.xingkaixin.me`。
使用 mise 全局安装且已登录的 `cf`，不要将 `cf` 或 Wrangler 加入项目依赖。
`pnpm deploy:www` 构建契约和 Astro 站点，生成 `.cloudflare/output/v0/`，
然后运行 `cf deploy --prebuilt`，避免自动配置安装构建工具。
输出采用 cf 当前的 v0 beta 格式，已使用 cf 1.0.0-beta.12 验证。
只验证、不上传时，先运行 `pnpm --filter @codesesh/contract build` 和
`pnpm --filter @codesesh/www build:cf`，再运行
`(cd apps/www && cf deploy --prebuilt --dry-run)`。

准备脚本生成 `_headers`，仅为构建中实际存在的 `/_astro/` 资源设置一年缓存。
Workers 会将通配符响应头应用到 404，因此使用精确路径避免缓存缺失资源。
HTML 和未版本化文件使用 Workers 默认策略。部署产物排除 Finder 元数据。
部署显式启用尾斜杠 URL 和 `404-page`，使用 `apps/www/public/404.html`，
让缺失资源返回 404，而不是首页。统计仅使用 Umami，保持 Cloudflare Web Analytics
自动注入关闭。

Pages 迁移已完成，旧 Pages 项目可以删除。站点仅通过正式自定义域名提供访问；
生成的部署配置显式关闭 `workers.dev` 和版本预览地址。

### 复现 CI 必需检查

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 是事实源，包含 Rust、前端、浏览器和
原生制品检查。下列命令列出工作流门禁，按对应 job 顺序运行；`pnpm clean` 后需重新构建 Web。
含 `${{ matrix.* }}` 的打包行是 CI 模板，本地使用 `pnpm package:artifact`；
`verify-set` 需要先汇总四个 runner 的制品：

<!-- repo-fact:ci-commands:start -->

```bash
pnpm install --frozen-lockfile
node scripts/check-quality-task-coverage.mjs
pnpm build:web
pnpm lint
pnpm format:check
pnpm typecheck
pnpm typecheck:e2e
node scripts/release-preflight.mjs
node scripts/check-docs-paths.mjs
node scripts/check-docs-facts.mjs
pnpm clean
pnpm test:coverage
pnpm --filter @codesesh/web test:bundle
pnpm generate:rust-contract
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm test:rust:platform
pnpm build:rust
node --test scripts/rust/packaging.test.mjs
node --test scripts/rust/publish.test.mjs
pnpm test:backend
pnpm perf:check
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
node scripts/rust/pack.mjs ${{ matrix.target }} target/release/${{ matrix.executable }}
node scripts/rust/smoke.mjs --contracts
node scripts/rust/verify-set.mjs
```

<!-- repo-fact:ci-commands:end -->

本地运行只覆盖当前主机。原生目标为 macOS arm64/x64、Linux x64 GNU（glibc 2.35+）和 Windows x64；
各目标仍需要对应 runner 和安装验收。详见[制品指南](docs/rust-packaging.md)。

### 性能 Benchmark

```bash
# 使用 warm cache，对自动选择的代表性会话跑 benchmark
pnpm bench:perf -- --days 0 --iterations 3

# 启用 cold start 和 React 渲染 profile
pnpm bench:perf -- --cold --react-profile --target heaviest --navigation direct
```

### CI 与发布边界

前端、契约、覆盖率、文档和完整 Rust 测试在 Linux / Node 24 执行一次。四个原生目标
都编译并检查文件发现、数据迁移、监听、SQLite 持久化、原生服务、进程生命周期和打包。
macOS 与 Windows 使用 `pnpm test:rust:platform`；每个目标的 npm 安装分别使用 Node 22.0.0
和 Node 24 验证。平台选择依据见[测试策略](docs/testing.md)。旧 Node 差分套件已移除，
锁定参考包仅保留给手动性能对照。

v1.1.0 将 Rust 原生后端纳入版本发布准备。更新版本号与发布记录不会发布包。
Release workflow 仅由 `v*` tag 触发；正式发布需单独授权并完成[发布清单](docs/release-guide.md)。

### 开发流程

构建并启动原生应用：

```bash
pnpm dev
```

修改后端或内嵌 Web 后，需要重新构建并重启进程。`pnpm serve` 启动已有构建。
也可以直接传入 CLI 参数：

```bash
./target/release/codesesh --cwd . --days 3
```

独立 Astro 产品站使用 `pnpm dev:www` 开发。

### 项目结构

```text
crates/codesesh-core/src/agents/       Agent adapters and source parsing
crates/codesesh-core/src/discovery/    Discovery, incremental scans, and backfill
crates/codesesh-core/src/runtime/      Watcher, single writer, and publication
crates/codesesh-core/src/storage/      SQLite schema, migrations, messages, and FTS
crates/codesesh-core/src/pricing/      Model prices and fixed pricing generations
crates/codesesh-core/src/analytics/    Dashboard and project aggregation
crates/codesesh-core/src/search/       Structured search and file activity
crates/codesesh-core/src/state/        Bookmarks and aliases
crates/codesesh-cli/src/               Clap CLI, Axum HTTP, embedded Web, and logs
crates/codesesh-cli/npm/               Thin npm launcher
packages/contract/src/                Browser-safe contracts and pure logic
packages/contract/src/generated/      Rust-generated TypeScript wire types
apps/web/                            React application
apps/www/                            Astro product site
scripts/rust/                        Native build, packaging, and benchmarks
```

### 扩展新 Agent

Agent 来源解析和浏览器展示分别声明：

1. 在 `crates/codesesh-core/src/agents/` 添加 Rust 适配器并注册扫描入口。
2. 在 `crates/codesesh-core/src/discovery/paths.rs` 添加默认路径和环境变量覆盖。
3. 在 `crates/codesesh-core/src/agents/catalog.json` 修改公开元数据和展示能力，再运行
   `pnpm generate:rust-contract`；浏览器端目录由此生成，不维护第二份值。
4. 在 `apps/web/public/icon/agent/` 和 `apps/www/public/icon/agent/` 添加 SVG。
5. 在 `apps/web/src/components/session-detail/tool-strategy/` 注册自定义工具展示。

使用来源格式 fixture 和进程契约检查消息、用量、工具及增量行为。注册检查覆盖图标、
resume 声明和工具展示策略。


本地数据库、模型价格缓存和日志默认统一放在 `~/.codesesh/`（Windows 为
`%USERPROFILE%\.codesesh\`）。首次迁移前请退出旧版本，并确认终端提示；非交互运行需在
退出旧版本后传入 `--migrate-data`。迁移校验通过后清理旧文件，所有保留路径都会逐项列出。
已有 `CODESESH_STATE_DIR`、`CODESESH_LOG_DIR` 配置继续有效。
详见[数据目录迁移](docs/sqlite-storage.md#数据目录迁移)。
