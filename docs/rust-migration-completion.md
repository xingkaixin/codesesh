# Rust 后端迁移汇总包

完整历史回填吞吐的后续优化见 [扫描吞吐报告](benchmarks/rust-backfill-throughput-2026-09-25.md)。

2026-09-25 后续解析、索引与常驻内存优化，以及 5,356 个本地会话的验收，见
[JSONL 解析与常驻内存报告](benchmarks/rust-streaming-memory-2026-09-25.md)。此前 P6 和本地内存报告保留其原构建指标。

本文汇总 P0～P7 的实现、兼容边界和复现入口。Rust 已成为唯一业务后端，全部适配器、
CLI/API、数据兼容和本机性能验收已经完成。四平台原生及八组 npm 安装已实跑通过；
最后的主包执行位差异已修复，最终提交的制品集合和 CI 状态以[PR 检查](https://github.com/xingkaixin/codesesh/pull/636/checks)
及交付包内的 `evidence/ci-results.json` 为准。P8 发布不在本轮内。

- 工作分支：`feat/rust-rewrite`
- PR：[Rust backend migration #636](https://github.com/xingkaixin/codesesh/pull/636)
- 固定 Node 参考：`codesesh@1.0.12`，源码参考提交 `a545f543a554421b0576058c701ef2ac4190d62e`
- 原 P6 性能候选（历史记录）：`91766747`；当时本机已安装二进制 SHA-256：`c82c438bd465f667a10e4375f21895520405d090d62421e20ca0528504fb65f1`
- 最终 CI：[PR #636 检查](https://github.com/xingkaixin/codesesh/pull/636/checks)；交付包记录固定 run URL、提交和全部 job 状态
- 合并门槛：PR 全部 CI 通过后 squash merge；实际合并状态以 PR 为准。
- 发布：**未执行**。继续本地验证，不升级版本、不创建 tag、不发布 npm 包；npm scope、平台包和正式发布权限在后续发布前核验。

## 迁移收尾（2026-09-26）

旧 `packages/core`、`packages/cli` 及 Worker 生产实现已删除；当前 pnpm workspace 只保留
前端、产品站和浏览器契约。旧代码的锁定参考制品和缓存 fixture 仍用于兼容验收，历史
方案、产品立项文档与 benchmark 保留其原始上下文，不作为当前架构说明。

CI 的前端矩阵收敛为 Linux / Node 24 单次质量检查，保留四目标 Rust、八组 npm 安装及
制品集合验证。Dependabot 同时跟踪 Cargo 依赖。发布 workflow 保持 tag 触发，不随合并发布。

后续重启复用、扫描进度、源移除和会话滚动行为见[扫描与缓存](scanning-and-caching.md)。
实测结果见[文件热启动](benchmarks/rust-warm-restart-2026-09-25.md)和
[数据库热启动](benchmarks/rust-database-warm-restart-2026-09-25.md)。

## 本地完整历史验收补充

原 P6 合成数据没有覆盖本机约 19.4 GiB Codex 来源及最大约 464 MiB 单会话。
针对 `pnpm run:app` 内存持续增长，`091d27d6` 改为保留会话元数据、按来源大小分批、
持久化增量指纹，并修复 macOS 持续打开 WAL 的监听遗漏。
本机二进制 SHA-256 为 `9ce24eaca7ef75ed5a2111c9caa629169ec6a7485894895a5545da4b384b3acf`。
真实数据规模、冷扫描、热启动、增量、RSS 曲线及未覆盖范围见
[本地内存与增量报告](benchmarks/rust-local-memory-2026-09-25.md)。
修复代码的四平台及安装验证 [CI 36132360691](https://github.com/xingkaixin/codesesh/actions/runs/36132360691)
共 19 项通过。原 P6 配对数字继续绑定原二进制，不作为本次修复后的重新对比结果。

## P0～P7 实现清单

实现与验证记录如下。代码候选后的打包权限修复没有修改 Rust 二进制；性能报告绑定已安装文件的完整哈希。

| 阶段 | 已落地实现 | 代码及验证入口 |
|------|------------|----------------|
| P0 固定参考 | 锁定已发布 Node 制品及依赖；隔离 HOME、Agent 来源、缓存、状态和日志；比较器负例；Node 初始基线 | `tests/reference/manifest.json`、`tests/reference/package-lock.json`、`scripts/prepare-backend-reference.mjs`、`tests/backend-contract/compare.test.mjs` |
| P1 Rust 最小链路 | 两个 Cargo crate；CLI、HTTP、SQLite、Codex 详情和增量游标；真实 React 浏览；Rust 导出 TypeScript 契约 | `crates/codesesh-core/`、`crates/codesesh-cli/`、`tests/backend-contract/slice.test.mjs`、`tests/backend-contract/browser-slice.test.mjs` |
| P2 全适配器 | 13 个 Agent 的文件或数据库读取、消息、工具、用量、父子关系和派生信息；项目身份及来源路径解析 | `crates/codesesh-core/src/agents/`、`crates/codesesh-core/src/discovery/paths.rs`、`crates/codesesh-core/src/projects/` |
| P3 持久化与查询 | 缓存 schema 34、用户状态 schema 3；迁移、FTS、详情、搜索、文件活动、Dashboard、项目、书签和别名；定价缓存与代际 | `crates/codesesh-core/src/storage/`、`crates/codesesh-core/src/state/`、`crates/codesesh-core/src/search/`、`crates/codesesh-core/src/analytics/`、`crates/codesesh-core/src/pricing/`、`tests/backend-contract/cache-roundtrip.test.mjs` |
| P4 持续同步 | 有界 blocking 扫描、同 Agent 串行、文件提示归并、窗口优先回填和持久 checkpoint；单 SQLite writer、事务读取、提交后快照/SSE；取消和固定定价票据 | `crates/codesesh-core/src/discovery/incremental.rs`、`crates/codesesh-core/src/discovery/backfill.rs`、`crates/codesesh-core/src/runtime.rs`、`crates/codesesh-core/src/runtime/`、`crates/codesesh-core/src/pricing/controller.rs` |
| P5 CLI 与 API | Axum 路由、CLI 参数、访问令牌、Host/Origin、TLS/可信代理、压缩、流式详情、SSE、日志及故障退出行为 | `crates/codesesh-cli/src/options.rs`、`crates/codesesh-cli/src/http/`、`crates/codesesh-cli/src/logging/`、`tests/backend-contract/full-api.test.mjs`、`tests/backend-contract/cli-options.test.mjs`、`tests/backend-contract/lifecycle.test.mjs`、`tests/e2e/` |
| P6 制品与性能 | Web 内嵌；四目标原生归档和 npm 平台包；精确版本 launcher；安装 smoke、制品哈希与集合检查；固定 Node/Rust 配对基准 | `crates/codesesh-cli/build.rs`、`crates/codesesh-cli/npm/`、`scripts/rust/`；性能见最终配对报告，平台报告随交付包保存 |
| P7 默认切换 | Rust 为唯一业务后端；旧 TypeScript 后端移除；独立浏览器契约、生成 wire 类型、Agent catalog 单源、根脚本、CI、制品流程与文档切换 | `packages/contract/`、`scripts/run-native.mjs`、`package.json`、`.github/workflows/ci.yml`、`.github/workflows/release.yml`；最终 CI 记录随交付包保存 |

适配器范围：Claude Code、Cursor、Kimi-Cli、Kimi-Code、Codex、Grok、Pi、OpenCode、ZCode、
DSH、DeepChat、Cherry Studio、MiniMax Code。公开目录唯一可编辑源为
`crates/codesesh-core/src/agents/catalog.json`，运行 `pnpm generate:rust-contract` 生成浏览器目录。

## 最终架构

```text
Clap CLI
  -> 启动定价缓存 / 固定代际
  -> Runtime 从 SQLite 恢复快照
  -> AgentScanner / 有界 blocking 任务
       -> 扫描、消息、项目身份、用量与派生信息
       -> ScanBatch + checkpoint + 定价票据
  -> 单 SQLite writer 提交事务
  -> 不可变快照 / SSE
  -> Axum HTTP / 内嵌 React Web
```

- Rust 负责业务后端。npm launcher 只选平台包并转发参数、环境、stdio、信号和退出码。
- React 与 Astro 继续使用 TypeScript。浏览器从 `@codesesh/contract` 导入契约，不导入服务器实现。
- HTTP 查询使用独立只读连接和事务，避免同一响应混合旧会话头与新统计事实。
- 新快照和 SSE 在对应 SQLite 事务成功后发布。被取消或定价过期的批次不能推进 checkpoint。
- 定价发布与 writer 提交通过读写锁互斥；一个扫描批次始终使用同一价格快照。
- `--json` 执行一次性扫描；热路径根据来源和项目身份决定是否复用内容缓存。价格变化从持久化计价输入重算消息费用及会话汇总，保留来源费用，不重写正文或 FTS。旧缓存缺少计价输入且相关价格变化时，才重新读取对应来源。
- 固定 Node 制品只存在于测试和对照流程，不进入生产回退路径。

详细边界见[架构](architecture.md)、[扫描与缓存](scanning-and-caching.md)和
[SQLite 存储](sqlite-storage.md)。

## 计划结构与实际落点

| 计划中的落点 | 实际代码 | 边界说明 |
|--------------|----------|----------|
| CLI 内的 runtime 目录 | `crates/codesesh-core/src/runtime.rs` 和 `crates/codesesh-core/src/runtime/` | Core 包含调度、监听和 writer 实现；CLI 显式调用 `Runtime::start` 并负责 shutdown，进程生命周期仍由 CLI 持有 |
| 独立 npm 包装 workspace | `crates/codesesh-cli/npm/` 的模板和打包产物 | npm manifest 与精确版本平台依赖由打包脚本生成；没有保留旧 CLI workspace |
| SSE 按字节限制缓冲 | `crates/codesesh-cli/src/http/event_buffer.rs` | 沿用固定 Node 参考的64个关键帧上限、数值进度合并和慢连接断开；不是整个应用事件队列的字节硬上限 |
| Core 的 contract 子目录 | `crates/codesesh-core/src/contract.rs`、`crates/codesesh-core/src/public_contract.rs` | Rust 内部领域类型和对外 wire 投影分别声明，输出到 `packages/contract/src/generated/` |

因此，Core 不只是纯计算库：`Runtime::start` 会创建后台任务和专用写线程。它不会在模块
加载时自动启动，但不能将实际实现描述成“Core 完全不启动线程”。HTTP、终端启动及退出
协调位于 CLI；上述目录差异应随最终代码一起评审，不修改历史方案以掩盖差异。

## 兼容性验收重点

| 边界 | 检查内容 |
|------|----------|
| CLI | 参数、默认窗口、JSON 结构、错误输出和退出码 |
| HTTP | 状态码、响应字段和值、数组顺序、过滤、分页、安全校验和压缩 |
| 消息 | 源记录计数与规范化消息计数的区别；工具、计划、推理、图片、用量、父子会话 |
| 时间与游标 | 毫秒小数精度、JSON 数值与字段顺序、消息摘要链和增量返回 |
| 存储 | schema 迁移、旧制品往返、重启恢复、FTS 修复、事务失败回滚 |
| 用户状态 | 书签和别名独立于会话缓存；清理缓存不删除用户状态 |
| 实时行为 | 文件更新和删除、持续追加、分页 checkpoint、SSE 当代快照、慢连接及退出 |
| 制品 | 脱离仓库运行、内嵌资源、npm 安装、原生/npm 二进制 hash 一致 |

已发现并修正的兼容差异记录在[迁移进度](rust-migration-progress.md)。失败样本和修复前报告均已保留，最终报告列明剩余取舍和未测量范围。

## 支持矩阵

| 原生目标 | 运行边界 | 最终候选验收记录 |
|----------|----------|------------------|
| `aarch64-apple-darwin` | macOS arm64 | 原生及 Node 22.0.0/24 安装通过；各制品 hash 见交付包 manifest |
| `x86_64-apple-darwin` | macOS x64 | 原生及 Node 22.0.0/24 安装通过；各制品 hash 见交付包 manifest |
| `x86_64-unknown-linux-gnu` | Linux x64，glibc 2.35+；CI/release 固定 Ubuntu 22.04 | 原生及 Node 22.0.0/24 安装通过；`getconf` 确认 glibc 2.35 |
| `x86_64-pc-windows-msvc` | Windows x64 MSVC | 原生及 Node 22.0.0/24 安装通过；各制品 hash 见交付包 manifest |

首版不支持更旧 glibc、musl 或 Linux arm64。npm launcher 最低需要 Node.js 22.0.0；
独立原生可执行文件不需要 Node。源码构建工具链以 `rust-toolchain.toml`、`mise.toml`
及根 `package.json` 为准。

各平台必须实际运行安装后的制品。编译成功、生成压缩包或 macOS 本机通过，都不能替代
其他目标的执行证据。[制品指南](rust-packaging.md)描述报告和校验要求。

## 可复现验证入口

以下命令可复现验收。完整矩阵以 CI workflow 为准，运行记录随汇总包保存。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm prepare:reference

cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm generate:rust-contract

pnpm lint
pnpm format:check
pnpm typecheck
pnpm typecheck:e2e
pnpm test
pnpm test:coverage
pnpm perf:check

pnpm test:backend
pnpm test:backend:compare
pnpm test:rust:slice
pnpm test:backend:full
pnpm test:migration
node --test tests/backend-contract/cli-options.test.mjs tests/backend-contract/lifecycle.test.mjs

pnpm exec playwright install --with-deps chromium
pnpm test:rust:browser
pnpm test:e2e
pnpm --filter @codesesh/web test:bundle

node scripts/check-docs-paths.mjs
node scripts/check-docs-facts.mjs
node scripts/release-preflight.mjs
```

生成契约后还应检查生成文件是否产生未预期差异。Rust 测试与 TypeScript 覆盖率是不同证据，
不能用 `test:coverage` 的百分比表示 Rust 后端覆盖率。

每个目标的原生 runner 运行：

```bash
pnpm package:artifact:test
pnpm package:artifact
pnpm package:smoke
```

汇总四个平台的制品目录和 smoke 报告后，再运行：

```bash
node scripts/rust/verify-set.mjs
```

性能对照入口：

```bash
node scripts/rust/benchmark.mjs --samples=5 --warmups=1 --requests=30 --extra-endpoints=true --rust=/absolute/path/to/installed/codesesh --output=docs/benchmarks/rust-migration-p6-final.json
```

按[性能验证说明](performance.md)保留相同机器、相同工作负载、交替运行和完整原始样本。
测量期间避免同时运行编译、测试或其他重负载。最终比较必须对应实际交付二进制。

## 本机配对性能结果

使用实际安装的 macOS arm64 制品，与固定 Node 1.0.12 在同一 Apple M1 Pro 交替执行。
每场景预热1轮、正式5轮，每个HTTP端点150个正式请求；36个完整样本（含预热）均通过
完整结果等价检查。下表为墙钟中位数与稳态采样RSS，不能外推所有平台和真实用户数据。

| 指标 | 30会话混合来源：Node → Rust | 600会话混合来源：Node → Rust | 单会话10,000消息：Node → Rust |
|------|---------------------------|----------------------------|-------------------------------|
| 热缓存 JSON | 169 → 20ms | 208 → 34ms | 176 → 20ms |
| 冷应用缓存 JSON | 255 → 64ms | 1,746 → 1,322ms | 934 → 503ms |
| 首个 HTTP 就绪 | 149 → 29ms | 144 → 29ms | 143 → 29ms |
| 稳态 RSS | 195 → 31MiB | 432 → 97MiB | 554 → 72MiB |
| 追加后完整发布 | 1,043 → 180ms | 7,946 → 194ms | 4,752 → 912ms |

聚合接口重复读取已消除。600会话下，projects p95为1.48 → 0.86ms，Dashboard p95为
1.95 → 1.03ms。普通搜索三个场景的p95均下降。

保留一项已解释的回退：600会话的emoji搜索p95为2.15 → 5.46ms。探针显示，每次请求在
同一SQLite事务内读取600个会话头约3.4ms；本轮保留该一致性读取成本，避免在未维护数据库
代际的情况下混用内存会话头和SQL命中。此取舍不影响结果等价，也不宣称所有查询均提速。

冷缓存指应用SQLite缓存，未清空OS页缓存。CPU计时分辨率、动态backfill样本数量、浏览器
可交互时间和物理读写量等测量限制详见[最终报告](benchmarks/rust-migration-p6-final.md)。
[修复前记录](benchmarks/rust-migration-p6-before.json)保留失败与回退原始样本。

## 回滚与数据保留

回滚使用先前验证过的旧版制品，产品中不内置自动 Node 回退。操作顺序：

1. 停止当前 CodeSesh，确认后台写入与 SSE 已退出。
2. 对会话缓存和独立用户状态库分别保留一致备份；使用 SQLite 备份方式或停机并完成 WAL
   检查点后备份，不单独复制仍在写入的主数据库文件。
3. 切回已验证的旧版制品。使用迁移往返测试确认过的数据库格式；对未知版本不要强制打开。
4. 若派生会话缓存需要重建，保留原文件后使用独立缓存重扫。不要把书签、别名或原始 Agent
   数据作为派生缓存清理。
5. 检查会话数、详情、搜索、书签和别名后再恢复日常使用。

会话缓存升级会保留迁移前备份，未来 schema 会被拒绝。17项迁移/往返检查已对固定旧制品执行，覆盖历史schema、FTS恢复和用户状态；最终CI再次运行同一验收入口。

## 验收证据索引

| 证据 | 当前记录 |
|------|----------|
| 候选身份 | 本文顶部、性能JSON的toolchain/binarySha256、四平台manifest及CI head SHA |
| Rust 静态检查与单测 | `91766747`：CLI 34 项、Core 157 项通过；3项外部探针由差分入口独立调用；Clippy 严格检查通过 |
| 全 API / CLI / 生命周期差分 | `91766747`：27 项进程测试通过，包含98项完整API观察、7组CLI、5项生命周期及适配器对照 |
| 浏览器 E2E 与 bundle | `91766747`：42/42浏览器E2E通过；最终CI继续核验bundle门禁 |
| SQLite / state 往返 | 17项迁移/恢复/旧制品往返检查通过，四平台CI分别实跑 |
| 性能 | 36 个完整样本等价且无执行错误；3场景各5轮正式测量；完整原始数据见[最终配对报告](benchmarks/rust-migration-p6-final.json) |
| 四平台原生及 npm 安装 | 四平台及八组Node版本安装通过；制品目录包含smoke-report、manifest和SHA256SUMS |
| 四平台制品集合 | `verify-set.mjs`严格检查平台完整性、文件哈希、安装报告及主npm包一致性；结果见交付包release-set.json |
| 最终 CI | 交付包 `evidence/ci-results.json` 记录同一PR head的固定run URL和全部19项检查；`evidence/pr.json`记录冲突状态 |

交付包包含本文、迁移方案与进度、最终性能原始报告、四平台制品及校验文件、smoke报告
和CI记录。Windows主npm归档的launcher执行位已统一为0755；四个真实CI主包经同一
规范化过程后SHA-256均为 `ed01a461aeea0f264ff87e80b30a56c6f879c1a72ebf45d0e0930360cf9c1f57`，
最终CI继续严格核对实际打包输出。主包元数据规范化不改变性能测量所用的Rust二进制。

P8 的 npm 权限核验、正式公开发布和发布后观察不在本轮内。当前没有执行真实 npm 发布、
创建发布 tag 或合并 PR。
