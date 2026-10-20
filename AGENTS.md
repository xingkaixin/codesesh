# CodeSesh

**用途**：发现、聚合、可视化受支持的本地 AI 编码 Agent 历史会话，通过 Web UI 统一浏览。

Rust workspace（`crates/`）+ pnpm/Turbo（`apps/`、`packages/`），工具链见 `rust-toolchain.toml`、`mise.toml`。

改动前按 `docs/README.md` 找对应文档；模块边界和运行模式见 `docs/architecture.md`；领域术语以 `CONTEXT.md` 为准。

## 验证

后端基本验证（涉及 CLI 的构建前先运行 `pnpm build:web`）：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

- `CODESESH_SKIP_WEB_ASSETS=1` 只用于 debug 后端检查，release 拒绝跳过 Web 资源。
- Rust wire 类型改变后运行 `pnpm generate:rust-contract`，并检查 TypeScript 消费者。
- 前端：`pnpm lint`、`pnpm format:check`、`pnpm typecheck` 和相关 Vitest 测试。
- 改 CLI、HTTP、SSE 或持久化：`pnpm test:backend`。
- 改界面流程：`pnpm test:e2e`。
- 改前端依赖或入口：`pnpm --filter @codesesh/web test:bundle`。
- 改文档：`node scripts/check-docs-paths.mjs` 和 `node scripts/check-docs-facts.mjs`。
- 改版本号：`node scripts/release-preflight.mjs`。
- 重命名或新增平台相关模块时，同步 `package.json` 中 `test:rust:platform` 的过滤条件。

验证命令不代表已经通过，报告结果必须保留实际运行证据。测试取舍见 `docs/engineering/testing.md`，
完整 CI 以 `.github/workflows/ci.yml` 为事实源，制品要求见 `docs/engineering/rust-packaging.md`。

## Web 设计规则

`apps/web/src` 的颜色和类名由 `.oxlintrc.json` overrides 中的 shadcn 规则检查，只用主题 token；
例外按具体类名添加，不用通配符。不要启用 `no-restyle`、`no-arbitrary-values`、`no-inline-styles`、
`require-static-classes`：图表和虚拟列表需要动态尺寸。Astro 产品站不在检查范围内。

## 扩展新 Agent

1. 在 `crates/codesesh-core/src/agents/` 新增 Rust 适配器，并接入：
   - `agents.rs`：`pub mod` 声明和 `scan_agent` 分发；文件来源在 `session_root` /
     `is_session_file` 声明会话文件，数据库来源在 `database_path` 声明 SQLite 路径。
     来源可用性、回填选择、数据库戳记和 `discovery/json_scan.rs` 的 JSON 扫描都读取这些函数，
     不另设分支。
   - `discovery/backfill.rs`：伴随索引文件加入 `inventory` 的 `context_names`。
   - `discovery/incremental.rs`：`watch_roots` 监听路径和 `read` 增量刷新。
   - 数据库来源另外对照 `deepchat` 在 `backfill.rs`（`inventory`、`session_fingerprints`）和
     `incremental.rs` 中的分支逐一接入。
2. 在 `crates/codesesh-core/src/discovery/paths.rs` 声明数据根目录、环境变量覆盖和扫描路径。
3. 在 `crates/codesesh-core/src/agents/catalog.json` 声明公开元数据和展示能力，然后运行
   `pnpm generate:rust-contract`；浏览器端目录由生成结果导出，不维护第二份值。
   `support` 按适配器实际解析结果声明分级与能力，并同步 README 中的能力矩阵。
4. 在 `apps/web/public/icon/agent/` 与 `apps/www/public/icon/agent/` 添加 SVG。
5. 自定义工具展示在 `apps/web/src/components/session-detail/tool-strategy/` 添加并注册。

适配器测试应覆盖真实格式、用量、工具和删除/失败行为。注册检查应覆盖图标、resume 声明和
工具展示策略；不要用额外包装层代替明确的来源解析。
