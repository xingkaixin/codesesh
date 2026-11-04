# 测试取舍与平台边界

测试只保留两类：证明产品或逻辑假设的测试，以及保证正确打包、安装和发布的测试。
产品或逻辑假设指一旦被破坏，产品会走样或数据会出错的规则，例如真实 Agent 格式解析出
正确的会话与用量、增量刷新不丢失也不重复会话、迁移保留用户数据、费用不重复计算。

只验证实现写法的测试不保留：组件接线、mock 调用次数、渲染次数、文案、CSS 类名、
DOM 结构、格式化辅助函数、快照式特征测试、性能预算和对测试工具本身的测试。
同一假设只在最接近真实数据或用户行为的一层验证一次。不按覆盖率补齐用例，也不设覆盖率门槛。

## CI 执行范围

| 检查 | 执行平台 | 原因 |
| --- | --- | --- |
| Web、浏览器契约、脚本和完整 Rust 测试 | Linux | 解析、费用、搜索、树结构、事件合并和前端状态等纯逻辑使用相同实现 |
| rustfmt、生成契约漂移、发布流程模拟 | Linux | 与目标 OS/CPU 无关 |
| Clippy | Linux、macOS arm64、Windows x64 | 检查平台条件分支；代码没有按 CPU 架构分支，macOS x64 与 arm64 结果相同 |
| 原生构建 | 四个原生目标 | 编译原生依赖并产出发布二进制 |
| Rust 平台测试子集 | macOS arm64、Windows x64 | 文件元数据、监听、权限、锁、原子替换、SQLite 和子进程有平台差异；Linux 完整套件已包含这些测试，macOS x64 与 arm64 是同一 OS，不重复执行 |
| CLI/HTTP/SSE 进程契约、退出与故障恢复 | 四个原生目标 | 验证真实二进制的进程、网络和持久化行为 |
| 打包与安装 smoke | 四个原生目标 | 二进制格式、tar 权限、路径和 launcher 有平台差异 |
| npm 安装 | 每个目标的 Node 22.0.0 / 24 | Node 24 在构建该目标的 job 内验证当前构建版本；Node 22.0.0 在干净 runner 上验证最低支持版本 |
| 浏览器 E2E | Linux | 应用行为无需重复占用原生平台矩阵 |

只改 `docs/`、根目录 `*.md` 或 `LICENSE` 时，CI 只运行 `Docs and versions`，其余 job 跳过。
过滤写在 job 上，不用 `paths-ignore`：工作流被跳过时必需检查不会上报，PR 会一直等待。
`CI OK` 汇总所有 job 的结果，跳过也算通过，必需检查只配置这一项。

CI 产出的二进制不发布，因此关闭 LTO 以缩短构建。发布用的 thin LTO 二进制由 Release 工作流
构建，并在四个目标上运行相同的安装与后端契约验收。

`pnpm test:rust:platform` 使用 libtest 的多个过滤条件，执行以下现有测试：

- Core：discovery（含 JSON 扫描）、data_migration、runtime、state、storage schema、pricing manager、
  worker store，以及 Antigravity CLI、Cursor、DSH、Kimi 的文件系统适配器测试和项目路径 / Git worktree 测试。
- CLI：日志、价格刷新、原生服务和 Worker 连接。
- 独立进程：data_migration、hub_worker 和 worker_scheduling（包括上传中的信号退出）。

SQLite 的完整查询、聚合与同步协议矩阵由 Linux 完整套件验证；其他目标保留 schema、
重开数据库、并发写入、WAL 监听和真实 Hub/Worker 恢复等原生边界检查。适配器中的纯
投影测试不需要跨平台重复；上述混合模块保留整个小测试组，避免维护逐用例白名单。
改名或新增平台相关模块时，同步检查平台命令的过滤条件。Release 使用相同的分工。

## 已退役的迁移差分

旧 Node 后端与 Rust 的 CLI、HTTP、适配器和缓存往返差分套件已完成迁移验收，现已删除。
CI 不再下载或启动参考后端。Rust 自身的 schema 升级、事务回滚和数据目录迁移测试继续运行。
`pnpm prepare:reference` 与 `pnpm bench:rust` 仅供手动重现历史性能对照，参考包不进入产品。
