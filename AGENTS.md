# CodeSesh

**用途**：发现、聚合、可视化受支持的本地 AI 编码 Agent 历史会话，通过 Web UI 统一浏览。

## 技术栈

- **后端**：Rust Cargo workspace；Axum HTTP、Clap CLI、Tokio 运行时、rusqlite SQLite。
- **前端**：TypeScript、React 19、React Router、Tailwind CSS 4、Base UI；产品站使用 Astro。
- **Web workspace**：pnpm（版本以 `package.json` 为准）+ Turbo。
- **契约**：`@codesesh/contract` 提供浏览器安全类型和纯逻辑；wire 类型由 Rust 生成。
- **质量工具**：Rust 使用 rustfmt、Clippy、cargo test；TypeScript 使用 oxlint、oxfmt、Vitest。
- **工具链**：Rust 版本见 `rust-toolchain.toml`；源码构建使用 `mise.toml` 固定的 Node 24。
  npm launcher 需要 Node.js 22+，独立原生可执行文件不需要 Node。

## 目录与职能

- `crates/codesesh-core/src/agents/`：13 个 Agent 适配器、来源解析和增量读取。
- `crates/codesesh-core/src/discovery/`：数据路径、扫描编排、窗口优先回填和 checkpoint。
- `crates/codesesh-core/src/runtime.rs`：有界扫描、取消、刷新和状态。
- `crates/codesesh-core/src/runtime/`：单 SQLite writer、监听和状态发布。
- `crates/codesesh-core/src/storage/`：schema 34、迁移、消息、FTS 和成本事实。
- `crates/codesesh-core/src/search/`：查询解析、候选召回、搜索片段和文件活动。
- `crates/codesesh-core/src/analytics/`：Dashboard 与项目统计。
- `crates/codesesh-core/src/pricing/`：价格缓存、代际、估价和成本来源。
- `crates/codesesh-core/src/projects/`：项目身份、分组和路径作用域。
- `crates/codesesh-core/src/state/`：schema 3 用户状态。
- `crates/codesesh-cli/src/`：CLI、HTTP、安全、SSE、资源和日志。
- `crates/codesesh-cli/npm/`：npm launcher 模板。
- `packages/contract/src/`：浏览器安全契约；`generated/` 为生成文件。
- `apps/web/src/`：React 应用、组件、hooks 和客户端请求。
- `apps/www/`：Astro 产品站。
- `scripts/rust/`：原生构建、打包、安装 smoke、制品集合检查和性能对照。

## 数据流

```text
Clap 参数 → SQLite 恢复快照 → Axum HTTP / SSE
→ AgentScanner 有界 blocking 扫描 → 单 writer 提交 SQLite / FTS / checkpoint
→ 不可变快照 / SSE → React Web UI
```

notify 事件触发对应 Agent 的后续刷新。扫描固定一个定价代际；旧代际批次不得提交。
`--json` 一次扫描后输出并退出。业务后端不依赖 Node 或旧实现回退。

## 验证

优先运行受影响 crate/workspace 的检查。后端基本验证（涉及 CLI 的构建前先运行 `pnpm build:web`）：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

CLI 构建需要已有 Web 资源；仅 debug 后端检查可显式使用 `CODESESH_SKIP_WEB_ASSETS=1`，
release 不允许跳过资源。契约类型改变后重新生成 TypeScript 并检查消费者。
前端使用 `pnpm lint`、`pnpm format:check`、`pnpm typecheck` 和相关 Vitest 测试。

- `pnpm test:backend`：真实进程 CLI、HTTP、SSE 和持久化契约。
- `pnpm prepare:reference`：获取锁定的旧 Node 参考制品，仅用于差分验收。
- `pnpm test:backend:compare`：对照参考与候选后端。
- `pnpm test:e2e`：Playwright 端到端，脚本先构建再运行。
- `pnpm --filter @codesesh/web test:bundle`：构建后检查首屏 bundle 预算。
- `node scripts/check-docs-paths.mjs`：文档路径必须存在。
- `node scripts/check-docs-facts.mjs`：repo-fact 标记块须与源码、脚本和 CI 一致。
- `node scripts/release-preflight.mjs`：Cargo 与前端版本一致性。

完整 CI 以 `.github/workflows/ci.yml` 为事实源。验证命令不代表已经通过，报告结果必须保留
实际运行证据。制品要求见 `docs/rust-packaging.md`，发布操作与代码迁移分开。

## Web 设计规则

根目录 `.oxlintrc.json` 的 `overrides` 对 `apps/web/src/**/*.{ts,tsx}` 启用
`shadcn/no-raw-colors` 和 `shadcn/no-unknown-classes`，检查主题颜色和无效类名。
组件与主题通过 `apps/web/components.json` 自动发现。运行
`pnpm --filter @codesesh/web lint` 检查，完整 CI 通过 `pnpm lint` 执行。

- `bg-grid` 是 `apps/web/src/index.css` 中的自定义背景类，不是颜色 token，
  因此仅在颜色规则中豁免。
- `session-tree`、`session-message-timeline`、`session-timeline-item` 是现有 DOM
  标记类，不生成 CSS，因此仅在类名规则中豁免。不要用通配符扩大例外。
- 暂不启用 `no-restyle`、`no-arbitrary-values`、`no-inline-styles` 和
  `require-static-classes`：现有组件允许样式组合，图表和虚拟列表需要动态尺寸与定位。
- Astro 产品站不在这些规则的检查范围内。

## 扩展新 Agent

1. 在 `crates/codesesh-core/src/agents/` 新增 Rust 适配器，在模块注册中接入扫描。
2. 在 `crates/codesesh-core/src/discovery/paths.rs` 声明数据根目录及环境变量覆盖。
3. 在 `crates/codesesh-core/src/agents/catalog.json` 声明公开元数据和展示能力，然后运行
   `pnpm generate:rust-contract`；浏览器端目录由生成结果导出，不维护第二份值。
4. 在 `apps/web/public/icon/agent/` 与 `apps/www/public/icon/agent/` 添加 SVG。
5. 自定义工具展示在 `apps/web/src/components/session-detail/tool-strategy/` 添加并注册。

适配器测试应覆盖真实格式、用量、工具和删除/失败行为。注册检查应覆盖图标、resume 声明和
工具展示策略；不要用额外包装层代替明确的来源解析。
