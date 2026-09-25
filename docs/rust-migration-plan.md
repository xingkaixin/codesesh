# CodeSesh 后端 Rust 迁移方案

状态：实施中，工作分支 `feat/rust-rewrite`。阶段证据与未完成项见[迁移进度](rust-migration-progress.md)。本方案描述目标结构，不表示各阶段已完成。

规划日期：2026-09-25。CodeSesh 参考提交：`a545f543a554421b0576058c701ef2ac4190d62e`，workspace 版本 `1.0.12`。开始实施时再次核对参考提交，后续差分验证固定使用同一份参考制品。

## 1. 目标与范围

将 CLI、HTTP/SSE、Agent 解析、扫描同步、SQLite、搜索、统计、价格和用户状态迁移到 Rust。React Web UI、Astro 产品站、浏览器内的展示逻辑继续使用 TypeScript。保留 `codesesh` 命令和 npm/npx 安装方式，增加直接运行的原生制品。

沿用本次讨论的前提：迁移开发成本和行为兼容风险可控。计划围绕最终架构、执行顺序和可核对的完成标准展开。已有测试是行为依据，优先复用；只补迁移跨越语言、进程或存储接口后确实缺失的验证。

本次迁移不夹带新 Agent、新搜索语义、UI 改版、桌面壳、插件系统或存储引擎替换。直接替换后端运行实现，最终不保留 Node 业务后端、FFI 桥接或 Rust 调用旧 Node 实现的生产路径。Node 继续用于前端构建、测试和 npm 启动包装。

## 2. 从 agent-dump 迁移中采用的方法

已读取引用任务“评估 Rust 重写 SWOT”，并检查 agent-dump 的迁移计划、最终验收、性能报告和当前发布代码。用户已确认该项目发布完成；当前本地 Cargo 版本为 `1.0.0`，参考提交为 `a8e7716eb5dea324d4cc3ec01d113d97204c4d30`。阶段文档中的“尚未发布”是当时记录，不作为当前发布状态。

| 已验证的方法 | CodeSesh 的采用方式 |
| --- | --- |
| 固定旧实现，差分验证独立于业务源码 | 固定 Node 参考制品、锁文件和 hash；同一测试驱动分别启动 Node 与 Rust |
| 先打通一条完整路径，再按来源批次扩展 | 首先完成 Codex 的扫描、缓存、列表和详情，再迁移其余 Agent |
| 功能矩阵逐项关闭 | 每项记录实现位置、验证入口和通过提交；接入 Agent 不等于完成验收 |
| 测量最终制品，保留回退样本 | 同机、同数据、同缓存条件交错测量；Node 的收益基线重新采集 |
| 多渠道使用同一原生文件 | npm 平台包与 GitHub 原生压缩包装入同一个已验收文件，校验 hash |
| 最后删除旧实现，固定外部参考继续可运行 | Node 后端退出主树后，CLI/HTTP 差分验证继续运行 |

agent-dump 曾出现 Rust 文件同步语义更强而使批量导出变慢，说明语言替换不能代替系统调用和工作负载核对。本项目重点核对 SQLite 写事务、TEMP 暂存、文件监听及后台刷新时的交互延迟，不继承 Python → Rust 的加速倍数。

参考材料：[迁移计划](https://github.com/xingkaixin/agent-dump/blob/a8e7716eb5dea324d4cc3ec01d113d97204c4d30/docs/rust-migration-plan.md)、[最终验收](https://github.com/xingkaixin/agent-dump/blob/a8e7716eb5dea324d4cc3ec01d113d97204c4d30/docs/rust-p6-completion.md)、[性能报告](https://github.com/xingkaixin/agent-dump/blob/a8e7716eb5dea324d4cc3ec01d113d97204c4d30/docs/benchmarks/rust-p6.md)。这些材料的方法可复用，Provider 实现只作为格式线索，CodeSesh 的行为仍以自身参考实现为准。

## 3. 当前必须承接的事实

| 范围 | 现状与迁移要求 |
| --- | --- |
| 两种生命周期 | Web 从 SQLite 恢复快照后开始后台刷新；`--json` 完成扫描和初始索引后输出退出 |
| Agent | 13 个：7 个文件型、6 个 SQLite 型；身份和能力声明保持一致 |
| 缓存 | `~/.cache/codesesh/codesesh.db`，当前 schema 34，含详情、成本事实、文件活动、FTS 和同步状态 |
| 用户状态 | 独立 `state.db`，当前 schema 3，保存书签和别名；路径按平台解析，支持 `CODESESH_STATE_DIR` |
| 发布顺序 | 补全 Project Identity → 提交 SQLite → 更新 Live Snapshot → 发 SSE |
| 刷新 | 不同 Agent 可并行，同一 Agent 的 refresh/backfill 串行；搜索写入统一排队 |
| 详情 | 优先读取物化消息，指纹失效、消息缺失或待重新索引时回源 |
| 浏览器契约 | `@codesesh/core/contract` 同时包含类型、Agent 目录和可执行函数；Web 与产品站均有使用 |
| 测试 | 已有 API、同步生命周期、数据库迁移、性能结构断言和 Playwright 测试；部分 API 测试通过 Hono 内存请求执行 |
| 分发 | 实际发布 npm 包为 `codesesh`；`@codesesh/core` 当前是 workspace 包，不独立发布 |

事实依据：[运行时架构](architecture.md)、[扫描与缓存](scanning-and-caching.md)、[SQLite 存储](sqlite-storage.md)、[发布指南](release-guide.md)，以及当前源码。参考提交之后新增的产品行为需要登记到迁移矩阵，不能悄悄改变旧实现基线。

## 4. 目标结构与技术选择

### 4.1 两个 Rust crate，保留前端 workspace

以下为拟议结构，不代表目录已经存在：

```text
Cargo.toml                       workspace，统一产品版本与依赖
Cargo.lock
rust-toolchain.toml
crates/
  codesesh-core/src/
    contract/                    对外数据类型及序列化
    agents/                      13 个 Adapter、注册表、来源同步
    discovery/                   一次性扫描、详情加载
    storage/                     缓存、用户状态、迁移、FTS
    search/                      搜索语法、召回与命中定位
    analytics/                   统计与项目聚合
    projects/                    Project Identity 与作用域
    pricing/                     价格快照、更新、代际与计算
  codesesh-cli/src/
    main.rs                      参数、启动与退出
    runtime/                     持续同步、监听、发布与取消
    http/                        路由、SSE、鉴权、静态资源
    logging/                     结构化日志、上下文、落盘
packages/
  contract/                      生成的 TS 数据类型、目录数据、浏览器纯函数
  cli/                           npm 启动包装
apps/web/                        React，保持现有交互
apps/www/                        Astro，保持独立构建与发布
tests/backend-contract/          进程级 CLI/HTTP/SSE 验收
tests/reference/                 旧版制品描述、hash、安装工具
```

依赖方向为 CLI → Core。Core 不依赖 HTTP、终端或 npm，也不自行启动后台线程。只有 CLI 拥有运行时生命周期。以模块承载领域职责，首轮不为每个领域单独建 crate；不建立通用 repository、任务总线或插件框架。

Agent 具有真实的多实现需求，保留单个明确 Interface 和 `enumerated` / `aggregate` 能力区分。文件源枚举、diff、解析、last-known-good 与删除判定由一个同步 Module 拥有，一次性扫描和后台刷新共同调用。HTTP 不直接操纵 Adapter 或数据库事务。

### 4.2 依赖选择

| 用途 | 首选 | 约束 |
| --- | --- | --- |
| CLI | Clap | 保留现有参数、默认值、别名、错误分类与退出码 |
| HTTP/SSE | Axum + Tokio | 保留 HTTP 契约、原生 TLS/可信代理模式、静态资源和连接生命周期 |
| SQLite | rusqlite，bundled SQLite | 保留现有 SQL 和迁移；验证 FTS5、trigram、自定义 SQL 函数及编译选项 |
| JSON | Serde / serde_json | 保留 wire 字段名、可选字段、数值和未知消息的处理语义 |
| 监听 | notify + 必要的轮询 | 监听只产生刷新提示；复用现有 Watch Plan 的行为规则 |
| TS 类型 | ts-rs | 从对外 Rust DTO 生成，不导出数据库行或运行时内部状态 |
| 日志 | tracing + 项目日志输出实现 | 对齐当前 JSON 字段、关联 ID、脱敏、队列上限及关闭时排空 |

P1 固定兼容的 Rust 工具链、具体依赖版本与 features，提交 Cargo.lock。价格 HTTP 客户端、TLS 接入和资源嵌入依赖只按实际调用补充，不提前搭建扩展层。官方能力依据：[Axum SSE](https://docs.rs/axum/latest/axum/response/sse/)、[rusqlite](https://docs.rs/rusqlite/latest/rusqlite/)、[notify](https://docs.rs/notify/latest/notify/)、[ts-rs](https://docs.rs/ts-rs/latest/ts_rs/trait.TS.html)。

### 4.3 契约和共享逻辑的归属

最终使用内部包 `@codesesh/contract`，替代前端对 `@codesesh/core/contract` 的引用。迁移期间旧 Core 可 re-export 同一份契约，避免建立两份维护源。

- HTTP 请求、响应和 SSE payload：Rust DTO 为类型来源，生成 TS 文件并纳入版本控制；CI 重新生成后必须无 diff。输入校验仍由 Rust 显式实现。
- Agent 目录：一份中立 JSON 保存公开名称、图标、来源、resume 和工具策略；Rust 注册表和 TS 消费同一文件，验证 13 个实现、图标和声明完整匹配。
- 浏览器纯函数：日期显示、引用构造、树投影、事件合并继续使用 TS。后端需要的同义计算用 Rust 实现，复用固定输入输出用例核对语义；不引入 WASM。
- 仓库事实：Agent 数量、schema 与产品版本分别从实际声明导出，迁移 `repository-facts` 和文档事实检查，避免产品站构建继续依赖旧 Node Core。
- JSON 细节：逐项核对 omitted / null、空数组、联合类型、时间单位、整数精度、费用计算、未知字段和对象顺序。字符串内嵌 JSON 属于字符串内容，不能在比较时任意重排。
- 搜索高亮偏移继续采用浏览器使用的 UTF-16 索引，不能直接返回 Rust UTF-8 字节偏移；中文、emoji 和组合字符沿用相关行为用例。

P1 先选择 Session Head、Session Detail 和 SSE 事件验证类型生成。生成工具不能正确表达的字段在 DTO 上显式标注；不通过放宽成 `any` 掩盖差异。

### 4.4 运行时与并发

```text
CLI / HTTP / Watcher
        ↓
Runtime：按 Agent 排队，持有 operation、generation、取消状态
        ↓
有界 blocking 工作：扫描 / 解析 / Project Identity / 详情
        ↓
Storage writer：一个专用线程串行提交缓存与索引
        ↓ commit 成功
发布不可变 Live Snapshot → SSE
```

Tokio 处理网络、定时和调度。有限的扫描与解析任务使用有界 blocking 执行；长期持有 SQLite 写连接的循环使用专用线程。读查询在有界 blocking 执行域中使用独立连接，不把同步 SQL 放进 HTTP 异步任务，也不把所有读取排在长时间 backfill 后面。

保留同 Agent 串行、跨 Agent 并行、backfill 排队、generation 失效和 durable checkpoint 的语义。已有封闭 operation union 转为 Rust enum，不重新组合成一组布尔开关。CPU 并发上限在 P1 给出简单默认值，在基准中验证；首轮不增加 Rayon 或另一套任务调度器。

运行时协调提交和发布：过期结果在提交前拒绝；一旦提交成功，必须处理相应发布，不能因后续取消而把已提交结果当作未发生。提交后、SSE 前退出时，下次启动从 SQLite 恢复。内存锁只用于替换快照，解析、SQL、Git 探测和网络写入不持有该锁。

取消需要显式实现：文件扫描在批次间检查取消，SQLite 长查询使用可中断能力，Git 子进程保留超时和回收。开始运行的 `spawn_blocking` 任务不能靠 `abort()` 强制停止，关闭流程需要停止接单、取消待运行任务、结束在途操作、关闭 SSE、排空日志并释放数据库。[Tokio 官方说明](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)

### 4.5 数据文件兼容

首个 Rust 版本沿用缓存 schema 34、用户状态 schema 3、路径和数据表示。语言迁移本身不要求 schema 升级。现有历史迁移和内容迁移必须继续可用；较新 schema 的处理分别遵守缓存库与状态库当前规则。

以下内容属于验收范围：复合 Session Reference、Project Identity、排序、source fingerprint、index/detail/content 版本、价格 generation、pending reindex、内容 hash、自定义 `codesesh_project_scope_path` 函数、FTS tokenizer/触发器及查询语义。版本标识和 hash 算法默认保持，避免仅因换实现而全量重新解析。

大批量详情仍以同一写连接上的 TEMP 载荷暂存，最终事务统一提升。保留磁盘暂存和内存上界，不把整批消息收集进一个 Vec 后才提交，也不把 TEMP 表意外拆到另一连接。

验收包含旧版 → Rust 升级，以及 Rust 写入后、停机再由旧版读取的往返。两套实现只对独立副本运行，禁止同时操作同一份用户数据库。书签和别名属于用户数据，不能随缓存清空或回退而删除。源数据库只读规则保持，SQLite 的 `-shm` 协调文件与源数据库/WAL 的持久内容分别判断。

## 5. 功能验收矩阵

实施时为每行补充 Rust 实现位置、实际测试入口、通过提交及已知差异。状态使用待实施、实现中、待验收、通过；不以测试总数或编译成功替代逐项验收。

| 范围 | 必须保留的可观察行为 | 现有依据 |
| --- | --- | --- |
| CLI | 参数、默认时间窗口、环境路径、stdout/stderr、帮助/版本、JSON、端口回退、浏览器启动和退出码 | `packages/cli/src/index.ts`，CLI/runtime-plan/exit 测试 |
| 文件 Agent | Claude Code、Codex、DSH、Grok、Kimi-Cli、Kimi-Code、Pi 的发现、摘要、详情和工具内容 | `packages/core/src/agents/` 及对应测试 |
| SQLite Agent | Cursor、OpenCode、ZCode、DeepChat、Cherry Studio、MiniMax Code；旧 schema、WAL、部分失败 | 同上；OpenCode V2 与桌面数据源测试 |
| 来源同步 | enumerated/aggregate、指纹、last-known-good、部分枚举、明确删除、路径消失后恢复 | 来源同步和 scanner 测试 |
| 会话与项目 | 复合身份、缺父/成环、层级统计、工作树/路径身份、作用域与排序 | `CONTEXT.md`、projects 与 Session Index 测试 |
| SQLite | schema/content 迁移、原子发布、暂存恢复、索引修复、clear/no-cache、重启恢复 | migration-smoke、cache 测试 |
| 搜索 | 语法、AND/短语、过滤、排序、snippet、高亮、文件活动、空查询与降级 | search、search-transport、query-scope 测试 |
| 统计与价格 | 项目/Dashboard、模型费用、缺时间回退、时区、活跃时段、价格更新和失败回退 | analytics、pricing、cost-facts、active-hours 测试 |
| 详情 | 物化命中、指纹失效回源、消息顺序、工具解析、大消息流式响应 | session-detail、session-detail-stream 和 E2E |
| 用户状态 | 书签导入、幂等写入/删除、别名、源消失后的展示与跨重启保持 | state、bookmark-handlers、session-alias-cache 测试 |
| 持续运行 | 初始缓存、refresh/backfill 串行、checkpoint、失败保留、队列取消、恢复 | live-scan、agent-sync-engine、backfill-lifecycle 测试 |
| HTTP | 17 个 method/path 组合、参数和 body 验证、状态码、字段、分页 cursor 与错误语义 | API 目录及 server 测试 |
| SSE | connected/status、增删改与层级投影、合并、心跳、慢客户端、连接额度、断开清理 | routes、事件缓冲与 live-refresh 测试 |
| 访问规则 | token、loopback Host/Origin、写入校验、可信代理、TLS、body 上限、静态路径 | server、remote-access、loopback 系列测试 |
| 日志 | 请求/操作 ID、JSON 字段、脱敏、截断、轮转、队列和退出排空 | logging、log-record、worker-log-drain 测试 |
| 浏览器与分发 | 全部现有 Playwright 场景、初始 bundle 预算、安装后的真实浏览与退出 | `tests/e2e/`、package smoke、bundle 测试 |

HTTP 清单以 `packages/cli/src/api/routes.ts` 为准，以下路径均带 `/api` 前缀：

| Method | 路径 |
| --- | --- |
| GET | `/config`、`/status`、`/agents`、`/projects`、`/sessions`、`/search`、`/file-activity`、`/sessions/:agent/:id`、`/dashboard`、`/bookmarks`、`/events` |
| PUT | `/bookmarks`、`/session-aliases/:agent/:id` |
| POST | `/bookmarks/import`、`/logs` |
| DELETE | `/bookmarks/:agent/:id`、`/session-aliases/:agent/:id` |

## 6. 验证方法

### 6.1 复用现有测试

优先把已有 API 行为断言变成接受服务地址的测试，分别对 Node、Rust 真实进程执行。Hono `app.request()` 和注入 mock 的测试不能原封不动运行于 Rust；保留其输入与预期，将内部结构断言改为公开结果或 Rust Module 的必要不变量测试。

继续使用 Vitest/Node 驱动进程级测试和 Playwright，不因参考项目使用 Python 而增加 Python 验证链。E2E 启动器改为接受命令和参数数组，保留启动 URL/token 捕获、端口就绪等待及退出清理，避免 shell 拼接。

Node 与 Rust 使用相同逻辑内容、独立物理目录的合成 fixture。隔离 HOME、XDG、APPDATA、各 Agent 数据根、缓存、用户状态和价格输入，禁止 fallback 到开发者真实会话。含日期窗口的用例使用固定绝对范围；相对时间用例使用同一参考时间或明确的容差。远程价格输入由本地固定响应提供。

### 6.2 差分比较规则

- CLI 比较退出码、输出通道和结构化内容；HTTP 比较状态码、必要响应头、字段和值，数组顺序保持。
- 只归一化已登记的随机 token、请求 ID、端口、临时根路径、运行耗时及采样时间；业务时间戳和业务 ID 保持原值。
- SSE 按操作序列比较事件类型、payload、允许的状态转移与最终收敛结果。进度合并次数可以不同，删除事实、终态和持久化先后不能被归一化掉。
- 数据库比较 schema 与领域查询结果，不比较数据库文件逐字节相等；源文件只读验证单独执行。
- 旧实现有已确认的错误时，记录最小复现、期望行为和差异原因；迁移不能自行将未实现项标为“有意差异”。

必须保留少量有辨别力的比较器自检：故意丢失一条消息、交换结果顺序、修改书签或漏发删除事件，应被拒绝。无需为比较器镜像实现建立大套测试。

### 6.3 有状态场景

复用或补齐以下序列：空缓存启动；热缓存启动；追加消息；文件替换/截断；坏记录后继续；源临时消失再恢复；窗口外历史保留；SQLite WAL-only 更新；refresh 与 backfill 交错；提交失败；提交前后中断并重启；书签/别名写入后重启；SSE 慢消费者与重新连接；SIGINT/SIGTERM 关闭。

顺序测试优先复用现有同步模块的可控调度点。需要精确覆盖“提交失败不能发布”等内部时序时，在 Rust Module 的真实事务接口验证，不向产品加入测试专用 HTTP 端点，也不靠随机 sleep 争抢时机。

## 7. 分阶段实施

阶段按依赖推进，不按文件数分摊。每个阶段完成后提交功能证据，再进入依赖它的阶段。

| 阶段 | 主要产出 | 完成条件 |
| --- | --- | --- |
| P0 固定参考与矩阵 | 旧版制品/hash、功能矩阵、进程测试入口、合成 fixture、Node 性能基线、平台清单 | 参考可在隔离目录运行；已有关键断言经进程驱动通过；错误结果会被比较器拒绝 |
| P1 Rust 骨架与 Codex 路径 | 两 crate、工具链、DTO 生成样例、Codex 解析、空库的 schema 34、列表/详情 HTTP、最小 Web 浏览 | Rust release 能启动，Codex CLI JSON 与列表/详情通过差分；至少一条真实浏览器路径通过；跨三 OS 编译测试 |
| P2 全部 Agent | 完整 Codex，随后其余 12 个 Adapter、来源同步与 Project Identity | 13 个 Agent 均具备摘要/详情/失败语义；注册、图标和工具策略一致；首个 slice 的临时限制全部登记 |
| P3 存储与查询 | 全部历史/内容迁移、FTS、详情缓存、成本/统计、价格、书签和别名 | schema 34/state 3 往返通过；搜索及统计结果对齐；状态不随缓存清空丢失 |
| P4 持续同步与发布 | Watch Plan、refresh/backfill、checkpoint、generation、串行提交、快照与 SSE | 完整状态序列通过；提交失败不发布；重启恢复；增量路径不重读未变正文 |
| P5 HTTP/CLI 完整对齐 | 17 个路由、鉴权/TLS/代理、分页、压缩/流式、SSE 上限、日志与退出、全部 CLI 选项 | 运行时功能矩阵关闭，制品项留 P6；Web E2E 在 Rust 后端通过；三平台进程契约通过 |
| P6 制品与性能 | 内嵌 Web、npm 包装、目标制品、版本同步、安装冒烟、配对性能报告 | 每个支持目标安装并跑核心流程；同目标渠道文件 hash 一致；回退场景已说明并处理 |
| P7 默认切换与清理 | Rust 成为唯一后端、删除旧业务实现/Worker 构建、契约包归位、CI/文档更新 | 无旧后端运行依赖；固定外部参考仍可差分；最终提交 CI 通过且 PR 无冲突 |
| P8 发布与线上安装验证 | 正式版本、更新日志、平台包/主包/GitHub Release、远端安装验收 | 发布集完整可安装；npm/npx 与原生下载真实运行通过，版本与 UI 一致 |

### P0：先把旧版变成可调用的参考

实施时使用隔离 checkout 和 `feat/rust-rewrite` 分支。P0～P6 保持 Node 为默认开发/发布实现，测试入口显式选择 Rust 命令；P7 才统一切换。迁移期间两者不共享可写数据库，也不向用户增加长期维护的后端选择开关。

从固定提交构建现有 npm tgz，记录源码 SHA、Node/pnpm、锁文件、tgz 与 fixture/evaluator hash。参考制品不要求先向 registry 发布。后续移除旧源码后，验证工具仍能安装这份制品；原生依赖必须在对应测试平台安装，不能复制本机 node_modules 到其他平台。

将现有测试映射到矩阵，先抽出 CLI JSON、基础 HTTP、书签和一次真实刷新序列作为驱动验证，不在 P0 重新抄写所有测试。其余断言随对应阶段迁移。

P0 同时确认既有文档承诺的平台、团队实际需要的平台及可用的 npm 平台包命名。平台变化在实施前明确登记。首批四目标不自动代表最终支持范围。

### P1：一条真实路径，尽早验证结构

实现 `--version`、最小必要参数、显式 Codex 数据根、完整处理该 slice 所需的消息类型、一次性 JSON、空缓存写入、列表和详情。可以显式标记尚不支持的启动模式/Agent，不能静默返回残缺成功结果；这些限制不进入最终发行版。

生成固定 fixture 的 DTO，验证 TS 类型与 Rust JSON 完全一致。复用前端列表/详情，直接连接 Rust 服务。最小路径所需的目录、config、访问 token 与只读保护一起完成；不等待 P5 才建立基本访问规则。

P1 不读写真实旧库。它可以创建完整当前 schema，但历史迁移、全量查询和持久化语义的最终验收由 P3 完成。

### P2：按来源行为分批

1. Codex 补齐所有消息、工具、子会话、用量与标题行为；Claude Code、Pi。
2. Kimi-Cli、Kimi-Code、Grok、DSH，覆盖各自目录、来源与运行时格式。
3. OpenCode、ZCode，包括旧 SQLite 和 OpenCode V2。
4. Cursor、DeepChat、Cherry Studio、MiniMax Code，包括数据库/WAL 变化和容错。

每批至少覆盖发现、摘要、详情、缺字段/坏记录和来源生命周期；测试由现有对应 Adapter 用例迁移。重复格式解析可参考 agent-dump，归一化目标仍是 CodeSesh 的消息、统计和工具契约，不直接引入另一个产品的 Core 依赖。

### P3～P5：先完成数据语义，再完成持续运行

P3 关闭持久化与查询矩阵，包括旧 schema 的全部现有 migration fixtures、用户状态 v1/v2 → v3，以及 TS/Rust 小型共享算法的语义用例。首次扫描、重启和查询都必须基于真实 SQLite。

P4 将已验收的同步原语接入长生命周期。重点是事件提示后的真实核对、完整性与删除事实、持久化后发布，而非逐个翻译旧 Worker 类。JSON 模式仍禁用监听和后台刷新，完成初始索引后退出。

P5 核对路由和中间件执行顺序、raw Host/重复头处理、URL 编解码、body 大小、静态路径、TLS 与代理声明、日志和关闭流程。SSE 继续保持当前 32 连接上限、15 秒心跳、按字节限制的缓冲及慢客户端清理，不使用无限广播队列。

P5 完成时所有现有 Web 流程都应能对 Rust 运行；本阶段不改变视觉与交互设计。

### P6～P8：验证、切换和发布分开记账

P6 使用同一份 Web 构建结果生成所有目标制品。优先在构建阶段将 Web 资源嵌入二进制，保留 MIME、SPA fallback、静态路径和既有缓存/压缩语义。开发模式可读取本地 Web 输出，发行模式必须可脱离仓库运行。

内置价格快照等运行时数据也随原生文件打包。安装冒烟从与源码无关的工作目录启动，验证离线价格回退、页面和图标加载、API/SSE、一次文件更新、用户状态重启及进程退出，避免仅检查 `--version`。

P7 才删除旧 Node 业务后端和独有测试。所有被删除行为测试必须已由进程契约或必要 Rust 测试接替。前端依赖、浏览器纯函数和测试工具继续保留。清理 tsup Worker entry、better-sqlite3 生产依赖、旧 runtime exports、事实检查、coverage scope 和 benchmark 内部导入；验证工具仍需要的依赖可以留在 devDependencies。

P8 按项目发布流程执行。阶段状态区分“开发完成”“制品验收完成”“已发布”，未发布前不写已发布。合并仍遵循用户明确指令；本文不触发提交、PR、合并或发布。

## 8. 制品与发布方案

### 8.1 分发结构

`codesesh` npm 包保留命令名，改为薄启动包装。按平台选择同版本原生包，转发 argv、环境、stdio、信号和退出码。正常安装路径通过平台包分发，不要求用户安装 Rust 或 C++ 编译器。禁用安装脚本时仍应能运行已安装的平台包；缺失平台制品给出明确错误，不静默回退到 Node 后端。

建议平台包使用 `@codesesh/cli-<target>` 命名，实际名称在 P0 核对发布权限后固定。采用 npm optionalDependencies 的平台过滤；是否需要下载 fallback 由安装验收结果决定，不先复制 agent-dump 完整安装器。GitHub Release 提供原生压缩包和 SHA-256 清单。本项目不增加 pip 分发。

### 8.2 平台范围

| 首批验收目标 | Rust target | 必需验证 |
| --- | --- | --- |
| macOS arm64 | aarch64-apple-darwin | npm 安装、原生运行、Watcher、Web、信号退出 |
| macOS x64 | x86_64-apple-darwin | 同上，不能仅交叉编译后声称已验证 |
| Linux x64 | x86_64-unknown-linux-gnu | 同上，声明并实跑最低 glibc 环境 |
| Windows x64 | x86_64-pc-windows-msvc | 同上，补充带空格/Unicode 路径、文件占用与进程清理 |

Linux arm64、musl、Windows arm64 先在 P0 做支持范围核对：若既有承诺或实际发布要求包含它们，加入必需矩阵；否则明确标注首批未覆盖，不以“跨平台”概括。Linux 可参考 agent-dump 的 glibc 2.17 构建方法，但 CodeSesh 的 HTTP/TLS 依赖需独立验证，不能照搬兼容结论。

原生下载方式无需 Node。npm 包装保持当前 Node 22+ 承诺，并至少验证 Node 22.0.0、开发工具链版本及无开发依赖环境。

### 8.3 一个版本来源，一套已验收文件

根 Cargo workspace 的产品版本作为最终来源，CLI/Core 继承。脚本同步 npm 主包、平台包、Web、产品站和契约包的版本；Cargo.lock 一并更新。CLI `--version`、Web `__APP_VERSION__`、tag 与制品 manifest 必须一致。

CI 和 Release 复用构建及验证步骤。发布流程：构建全部目标 → 安装验收 → 校验版本/架构/hash/完整集 → 发布全部平台包并确认可下载 → 发布 `codesesh` 主包 → 创建含相同原生文件的 GitHub Release → 从公开渠道重新安装验证。更新日志和版本预先提交。

npm 发布不能回滚覆盖同版本。重试时核对已发布平台包的实际文件；同版本 hash 不同则停止，不能略过冲突继续发布主包。保留上一版本可安装；本次保持 schema 的前提下，停掉 Rust 后应能用旧版读取其写入状态，回退演练在隔离副本完成。

## 9. 性能验收

沿用现有[三层性能保障](performance.md)：PR 保留结构断言和增长率检查；真实墙钟测量本地或独立任务执行。前端首屏 bundle 预算继续保留。

| 场景 | 核心指标 |
| --- | --- |
| version/help 与热缓存 Web 启动 | 进程启动、端口就绪、首个可用列表、首屏可交互分别计时 |
| 空库首次索引：文件型、SQLite 型、混合 | 扫描/索引耗时、CPU、峰值 RSS、写入量 |
| 热缓存空刷新与单 Session 追加 | 解析/查询次数、写入量、事件到可查询/可见的延迟 |
| 大消息详情与搜索 | 首字节、完成时间、峰值 RSS；冷/热缓存和中文/emoji 分开 |
| Dashboard、项目与活跃时段 | 相同查询结果下的延迟、查询计划与读取量 |
| backfill 中的浏览和搜索 | 稳态请求 p50/p95、刷新延迟、队列长度 |
| 空闲和监听压力 | 常驻 RSS、空闲 CPU、突发变更后的内存恢复 |
| 安装制品 | 下载/解压体积、实际磁盘占用；内嵌 Web 大小单独列出 |

同机同条件，Node 参考与 Rust release 交替顺序，建议预热 1 次、正式 5 次；延迟分位数另需每轮足够请求，不能把 5 个样本当作可靠 p95。保留原始样本、CPU/RSS 定义、SQLite 版本/编译选项、结果等价断言和 source hash。OS 页缓存未清空就不能宣称冷磁盘测量。

P0 先记录基线，P6 比较最终安装制品。验收要求：现有结构和增长率门禁通过；各场景没有未解释的明显回退；资源/响应收益有同条件证据。持续回退先定位后决定修复或登记取舍，不能靠放宽比较器掩盖。具体性能目标在 P0 数据之后确定，本计划不承诺统一加速倍数。

## 10. CI 与提交组织

迁移期保留旧质量门禁，增加独立 Rust fmt、Clippy、test 和生成契约检查。Rust 三 OS 测试不乘以 Node 版本矩阵；Node 版本矩阵只覆盖仍受它影响的前端工具/测试与 npm 包装。完整 Web E2E 在 Rust 上执行，跨平台另运行进程契约和安装冒烟。

最终必需检查包含：Cargo 锁文件与编译、fmt、Clippy、Core/运行时测试、CLI/HTTP/SSE 契约、历史库迁移与当前库往返、前端 lint/typecheck/test/build、bundle、Playwright、支持目标制品安装、版本/契约/文档事实一致性。coverage ratchet 迁移前做映射，不能删除旧 scope 后把下降误报为达标；Rust 行为保障优先，覆盖率工具仅在现有强制 scope 确需替代时接入。

建议按阶段建 PR，每个 PR 包含一个可验收结果。P2 按四批 Adapter 拆分；P3 可按存储、搜索统计、用户状态拆分。若用一个迁移 PR，仍按这些行为切面拆 commit。英文标题与提交遵循现有规范，例如：

```text
test: Add backend contract harness
feat: Add Rust Codex browsing path
feat: Port SQLite agents to Rust
feat: Preserve cache and state compatibility
feat: Add Rust background synchronization
feat: Package native CodeSesh binaries
refactor: Remove the legacy Node backend
```

具体破坏性变化才使用 `!` / BREAKING CHANGE，不因内部语言替换自动宣称破坏 API。每次提交 PR 后检查最终提交的 CI 与冲突状态，修复后再交付；测试规模只反映覆盖情况，阶段是否通过以矩阵和证据为准。

## 11. 最终完成标准

- [ ] 13 个 Agent 和功能矩阵全部通过，无静默降级、临时拒绝或未登记差异。
- [ ] 所有 HTTP/CLI/SSE 契约、持续运行状态序列和真实浏览器流程通过。
- [ ] 历史升级、当前库往返、书签/别名保留和源数据只读验证通过。
- [ ] Node 后端、Worker 协议及其生产依赖退出；浏览器契约和产品站不再依赖旧后端。
- [ ] 固定参考制品、fixture、比较规则和性能原始记录可复现。
- [ ] 支持平台的原生文件与 npm 安装制品均已实际运行，发布集版本和 hash 一致。
- [ ] 最终提交的 CI 通过，PR 无冲突，README/架构/开发/发布文档与代码一致。
- [ ] 正式发布后，公开 registry 与 Release 下载分别安装验证成功。

执行入口为 P0。后续任务可按阶段引用本文件推进；阶段记录只更新实际完成的条目和证据，不把计划内容写成已实现能力。
