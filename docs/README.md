# 文档地图

| 目录 | 内容 | 读者 |
| --- | --- | --- |
| [product.md](./product.md) | 目标、非目标、核心任务与取舍原则 | 所有改动的起点 |
| [architecture.md](./architecture.md) | 运行模式、模块边界、设计原则与一致性约束 | 修改后端或契约前 |
| [design/](./design/) | 子系统的设计决策与数据语义 | 修改对应子系统前 |
| [agents/](./agents/) | 个别 Agent 的格式兼容说明 | 修改对应适配器前 |
| [guides/](./guides/) | 面向用户的操作指南 | 使用者 |
| [engineering/](./engineering/) | 测试、性能、打包与发布流程 | 维护者 |

## design/

- [scanning-and-caching.md](./design/scanning-and-caching.md)：扫描、回填、checkpoint 与刷新
- [sqlite-storage.md](./design/sqlite-storage.md)：schema、迁移、搜索索引与数据目录
- [hub-worker.md](./design/hub-worker.md)：多机采集的身份、协议与恢复语义

## agents/

- [antigravity-cli.md](./agents/antigravity-cli.md)
- [minimax-code.md](./agents/minimax-code.md)
- [opencode-v2.md](./agents/opencode-v2.md)

其他 Agent 的格式由适配器代码和测试样本说明，不单独成文。

## guides/

- [hub-worker.md](./guides/hub-worker.md)：Hub/Worker 部署、后台服务、迁移与恢复

## engineering/

- [testing.md](./engineering/testing.md)：测试取舍与平台边界
- [performance.md](./engineering/performance.md)：性能保障与测量方法
- [rust-packaging.md](./engineering/rust-packaging.md)：原生制品构建与验收
- [release-guide.md](./engineering/release-guide.md)：版本整理与发布

## 维护规则

- 文档记录当前事实和设计决策，不记录过程。实施计划、进度和验收记录写在 PR 里，合并后不再保留。
- 历史文档直接删除，需要时从 git 历史查找，不建立归档目录。
- 代码路径会由 `node scripts/check-docs-paths.mjs` 检查；可从源码推导的事实用 repo-fact 标记，由
  `node scripts/check-docs-facts.mjs` 检查。
- 新增文档时放入上表对应目录，并在本页登记。
