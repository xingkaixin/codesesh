# Rust 迁移进度

范围：执行 [P0～P7](rust-migration-plan.md)，P8 发布不在当前任务内。

参考提交：`a545f543a554421b0576058c701ef2ac4190d62e`。分支：`feat/rust-rewrite`。

## 阶段状态

| 阶段 | 状态 | 证据与剩余项 |
| --- | --- | --- |
| P0 | 基础验收通过 | 固定参考、进程契约及基线已建立；`a79f890c` 的三 OS × Node 22/24、smoke、制品检查全部通过；平台包权限留待 P6 核实 |
| P1 | 实施中 | 两 crate、Codex 文本路径、schema 34 创建、DTO 生成、CLI/list/detail/cursor 差分和 React 详情页本地通过；持久缓存接线已本地通过，三 OS 最终检查待完成 |
| P2 | 实施中 | 13 个适配器与增量入口已实现，正在完成固定 Node 的完整 HTTP/游标差分和小数时间兼容 |
| P3 | 实施中 | 存储、搜索、统计、定价、用户状态已接入；历史 schema 全矩阵和往返验收待完成 |
| P4 | 实施中 | 单写者、不可变快照、notify 增量、取消和 SSE 已实现；历史分批回填与定价代际集成待验收 |
| P5 | 实施中 | CLI 与 17 个端点已接线，正在全端点对照，尚未完成 E2E |
| P6 | 实施中 | 平台包装、npm launcher、Web 内嵌已实现；仅本机 arm64 安装基础验证通过，其他制品与性能待验收 |
| P7 | 准备中 | 独立浏览器契约包已提取；默认入口切换、旧后端清理、最终 CI 与汇总包尚未完成 |

## P0 参考与复现

本地从参考业务源码构建 npm tgz，SHA-256 记录在 `tests/reference/manifest.json`。同时固定已发布的 `codesesh@1.0.12` 和其 registry SHA-512；`tests/reference/package-lock.json` 固定全部安装依赖。两者的首批进程契约与 CLI JSON 差分均通过。

使用已发布固定制品作为持久参考，旧业务源码删除后仍可安装。参考安装目录位于忽略的 artifacts 下，不进入产品运行路径。命令：

```bash
pnpm prepare:reference
pnpm test:backend
pnpm test:backend:compare
pnpm bench:backend
```

`CODESESH_BACKEND_COMMAND` 接受 JSON 命令数组，默认运行当前构建的 Node CLI；后续传入 Rust release 文件路径。比较驱动的 `CODESESH_REFERENCE_COMMAND` 仅用于指定另一个参考进程或验证比较器，默认仍为冻结的 npm 制品。

输入使用合成 Codex JSONL，隔离所有 Agent 根、home、用户状态、缓存和日志；预写入有效价格缓存，避免网络影响。差分的两个候选按顺序复用同一份来源，清除中间派生缓存，直接比较完整 JSON，不剔除业务字段或排序。

首批进程契约：

- CLI JSON：完整输出、Project Identity、摘要不包含正文、进程正常结束、源文件未修改。
- HTTP：鉴权、config/list/detail/search、非法书签输入。
- 用户状态：书签和别名写入、停机、重新启动后恢复、删除。
- SSE：connected/status、追加文件、等待已发布消息数、立即读取对应详情。
- 比较器：实际启动参考和候选子进程；遗漏 Session、身份变化、顺序变化必须失败。

这不是全部功能验收，其他 Adapter、查询参数、错误分类和并发序列随 P1～P5 迁移。

## P0 验证记录

2026-09-25，本机 macOS arm64 / Node 24.21.0 / pnpm 12.4.2：原有 `pnpm test` 通过，Core 1,163 passed / 1 skipped，CLI 653 passed，Web 898 passed。本地源码构建版与固定 npm 版均通过首批三个进程契约；比较器自检和完整 JSON 差分单独运行。

P0 仅改动迁移验证工具、CI 与说明，没有修改后端业务行为。CI 在既有 Linux/macOS/Windows × Node 22/24 构建后增加进程契约，Linux smoke 增加冻结参考差分；远端通过状态以 PR 最终检查为准。

## P0 性能起点

原始样本：[Node P0 JSON](benchmarks/rust-migration-node-p0.json)。同机、单 Session / 两条消息，每场景一次预热、五次正式采样。价格缓存已预置，OS 页缓存未清空。该规模用于验证评估链路，不能代表完整历史性能。

| 场景 | wall time 中位数 | 峰值 RSS 中位数 |
| --- | ---: | ---: |
| version | 110.53 ms | 79.67 MiB |
| 冷应用缓存 JSON | 214.32 ms | 103.52 MiB |
| 热应用缓存 JSON | 170.72 ms | 102.28 MiB |
| Web 启动至初始扫描完成 | 275.59 ms | 未测 |

前三项通过 OS time 工具测量单进程峰值 RSS；Web 不套用 time 包装以免改变信号转发和退出行为。后续 P6 增加大历史、混合 Agent、后台负载与稳态延迟，并同时重新测量两个实现。

## 平台与分发记录

当前 README 说明三种 OS 的 CI，没有声明额外 CPU 架构。首批原生安装矩阵按计划为 macOS arm64/x64、Linux x64、Windows x64；其余架构不得在文档中宣称已覆盖。Linux 最低 glibc、额外架构和 npm 平台包实际权限在制品实施时核实。

主包继续使用 `codesesh`。当前仅固定已发布参考，不创建平台包或执行 registry 发布。

## P1 首个实现切面

Rust 工具链固定为 1.90.0。两个 crate 和 Cargo.lock 已建立；使用 Axum、Tokio、rusqlite bundled SQLite、Serde、ts-rs。生成的 DTO 当前位于 Rust Core 的 bindings 目录，尚未替换现有浏览器契约包。

已验证：

- 同一 Codex fixture 的 CLI JSON、公开列表、详情和消息游标与固定 Node 1.0.12 完整相等。
- 现有 React 页面直接读取 Rust 详情，显示标题、中文/emoji 用户消息和 assistant 正文，没有页面 JavaScript 异常。
- 未授权请求、非法 Host、跨源 Origin 被拒绝。
- schema 34 的 SQLite 建库、写入、关闭/重新打开、FTS5 与 trigram 查询通过；注入第二个 Session 的事务失败时，前一个 Session 不残留，也不暴露未提交游标。

当前限制必须保留在验收状态中：CLI 已使用隔离 home 下的磁盘 SQLite，HTTP 从已提交消息读取；启动仍重新扫描来源，完整热缓存恢复留待 P3/P4。为保护历史数据，预览版只接受空库或自身建立的缓存，拒绝既有 Node 缓存；只接受显式 CODEX_HOME 与 `--agent codex`。已加入基础用量累计去重、缓存读取费率和八位小数费用计算，并以带定价 fixture 比较 CLI/详情/游标；尚未支持计划、复杂工具/子会话、完整 Project Identity 和 Smart Tags。非 Codex Agent、其他 API、分页和后台刷新尚未迁移。浏览器详情测试不代表 Dashboard、侧栏项目、书签或实时功能通过；这些请求目前明确返回 501。Node 仍为默认实现。

复现首个切面：

```bash
pnpm build
pnpm prepare:reference
cargo build --release --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm generate:rust-contract
pnpm test:rust:slice
pnpm test:rust:browser
```

新增独立 Rust 三 OS CI，不乘以 Node 版本矩阵。跨平台状态以包含该实现的提交为准，不能沿用 P0 通过结果。
