# 性能验证

Rust 后端的性能需要实际测量。语言、静态链接或单一可执行文件都不能直接证明吞吐、启动
耗时或内存改善。每份结果应记录 commit、工具链、平台、CPU、样本规模、缓存状态及测量次数。

## 结构性检查

优先用确定性事实保护性能：查询次数、分页大小、重读会话范围、内存缓存条目数、索引计划
和前端 bundle 字节数。相关测试与实现放在一起：

| 范围 | 位置 |
|------|------|
| Cursor 增量同步与分页 | `crates/codesesh-core/src/agents/cursor/` |
| OpenCode 数据库增量读取 | `crates/codesesh-core/src/agents/opencode/` |
| SQLite 事务、消息和 FTS | `crates/codesesh-core/src/storage/tests.rs` |
| 搜索和文件活动 | `crates/codesesh-core/src/search/tests.rs` |
| 扫描并发、取消与发布 | `crates/codesesh-core/src/runtime/tests.rs` |
| 首屏 JS gzip 预算 | `apps/web/tests/initial-bundle.test.ts` |
| 详情缓存条目上界 | `apps/web/src/lib/session-detail-cache.test.ts` |
| 虚拟列表测量和提交 | `apps/web/src/components/session-detail/message-list.test.tsx` |

确定性测试不使用单点毫秒阈值，避免将机器负载当成代码回归。

## 固定参考制品对照

```bash
pnpm prepare:reference
pnpm build
pnpm bench:rust -- --samples=5 --warmups=1 --requests=30
```

脚本比较固定 Node 制品和当前 Rust release 二进制，使用隔离的合成来源和缓存。默认
输出路径是 docs/benchmarks 下的 rust-migration-p6-current.json。可以通过 `--rust=<path>`
选择候选二进制，通过 `--output=<path>` 指定结果文件。

当前工作负载包括混合小样本、混合历史和大单文件。运行参数和脚本内容以
`scripts/rust/benchmark.mjs` 为准。应保留原始样本，检查响应一致性，再分析启动、请求
分布和内存。单个 fixture 的结果不能代表所有 13 个 Agent 的真实历史。

迁移前基础数据保存在 `docs/benchmarks/rust-migration-node-p0.json`。它用于追溯固定参考
制品的小样本基线，不是最终容量或性能承诺。

## 浏览器与增长率

```bash
pnpm perf:check
pnpm bench:perf -- --days 0 --iterations 3
pnpm --filter @codesesh/web test:bundle
```

增长率检查用于发现规模扩大后的数量级退化；浏览器基准用于观察首屏、导航和详情渲染。
两者不能互相替代。浏览器基准使用本机历史时，报告必须说明会话数、消息数、最大单会话
大小和冷暖缓存状态，且不要把本机数据提交到仓库。

首屏预算测试需要先构建 Web。后端脚本读取原生二进制时，需要先完成 Web 构建和 Rust
release 构建；debug-only 跳过资源打包不能作为可发布制品的性能结果。

## 性能结论的边界

- 与固定版本比较时，必须记录双方版本和相同工作负载。
- SQLite 文件大小、WAL 和进程 RSS 是不同指标，应分别报告。
- 先确认响应、消息数、成本和增量游标一致，避免把漏解析当成提速。
- 发布前应在目标平台运行，而不只验证交叉编译成功。
- 历史 TypeScript 微基准属于对应历史 commit，不能沿用为 Rust 实现的测量结果。
