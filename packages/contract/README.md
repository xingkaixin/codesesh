# @codesesh/contract

独立的浏览器契约包。公开服务 DTO 由 Rust 生成，浏览器纯函数仍使用 TypeScript。本包不依赖 Node 运行时、SQLite 或 Agent 扫描模块；旧入口与 Web 使用方待 P7 统一切换。

| 旧入口                         | 新入口                             |
| ------------------------------ | ---------------------------------- |
| `@codesesh/core/contract`      | `@codesesh/contract`               |
| `@codesesh/core/test-fixtures` | `@codesesh/contract/test-fixtures` |

主入口保留原公开类型名和运行时导出。fixture 只从测试入口导出。原契约 111 个测试覆盖纯函数和构建产物的浏览器安全性。

## 单一来源

`crates/codesesh-core/src/contract.rs` 定义共用基础类型和内部解析模型；`crates/codesesh-core/src/public_contract.rs` 定义公开服务 DTO。后者复用基础 SessionReference、SessionStats、MessageTokens、Role、CostSource 及闭合枚举。只有公开可选性或字段集合与内部解析模型不同的会话/消息 DTO 使用独立 wire 类型。

本包中的服务 DTO 均为 generated 类型的重导出或组合，已移除重复手写字段：

- 会话头、详情、消息、工具/图片/计划部分、文件活动、Agent 信息。
- 配置、项目聚合及分页、搜索结果/高亮。
- SSE 会话变化、扫描阶段、回填和搜索维护状态。
- 书签与可用性变体。
- Dashboard、逐模型成本及时间窗。

TypeScript 只组合 UI 需要的类型：identified 会话要求 project_identity 存在，内部缓存字段通过 Pick 引用 Rust 内部模型，图片变体通过 Extract/交叉类型取得。没有复制服务字段或放宽成 any。ProjectIdentityKind、SmartTag、FileActivityKind、ToolPartStatus、PlanApprovalStatus 等闭合值由 Rust 枚举决定。

生成器还保留旧 API 的 readonly identity 约束。ts-rs 没有 readonly 字段属性，因此 Rust exporter 对生成的 SessionReference 加 Readonly 包装，并标记公开会话的 reference 属性为 readonly；字段名称和字段类型仍由 Rust 定义生成。

UI 纯函数保留 TypeScript：日期、引用与路由编码、project identity 比较、会话排序/索引/树、SSE 事件合并、message part 规范化、file activity 展示提取。Agent catalog 的唯一数据来源是 Rust agents/catalog.json；exporter 生成前端 as const 数组，TS 包仅重导出与提供查询函数。AgentCatalogEntry 的共用字段由 WireAgentInfo 组合，原测试同时核对完整数组，防止名称、图标、resume 命令或策略字段漂移。

## 生成与验证

```sh
cargo run --locked --example export_contract
pnpm exec oxfmt --write packages/contract/src/generated
pnpm --filter @codesesh/contract build
pnpm --filter @codesesh/contract test
pnpm --filter @codesesh/contract lint
cargo test --locked -p codesesh-core public_contract::tests
```

不要手改 generated。CI 需要对生成目录运行差异检查。package build 不隐式运行 Cargo。

Rust serde 测试验证省略字段与显式 null 的区别、工具未知 JSON 值、图片必需内容、闭合枚举拒绝非法值，以及公开会话不输出内部缓存 provenance。迁移时另对旧包所有公开 interface/type 进行双向 TypeScript 可赋值检查。

## P7 接入点

Web 依赖和导入、默认入口、根质量任务清单、Vitest 项目/覆盖率列表、版本同步、生成脚本和文档事实检查需要统一切换。HTTP 服务应使用 public_contract DTO 完成边界序列化或验证，避免动态 JSON 绕过契约；仅生成前端类型不能替代后端端点差分测试。
