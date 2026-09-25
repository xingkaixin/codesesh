# Rust 迁移进度

范围：执行 [P0～P7](rust-migration-plan.md)，P8 发布不在当前任务内。

参考提交：`a545f543a554421b0576058c701ef2ac4190d62e`。分支：`feat/rust-rewrite`。

## 阶段状态

P0～P7 已实现并完成本地验收。四平台原生和八组 npm 安装已实跑通过，主包归档权限差异已修复。
最终交付须同时附上当前 PR head 的19项CI全绿记录和无冲突状态；记录保存在汇总包中。

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 | 完成 | npm 1.0.12 固定参考、integrity/lock、进程比较器拒错验证、Node 基线 |
| P1 | 完成 | 两 crate、工具链、Codex CLI/HTTP/游标、真实React浏览及契约生成 |
| P2 | 完成 | 13个适配器、项目身份、来源增量、毫秒小数及完整消息/游标差分 |
| P3 | 完成 | schema34/state3；17项迁移/往返/FTS恢复检查；搜索、统计、价格、别名和书签 |
| P4 | 完成 | 每批32来源单元，窗口/目标优先；持久checkpoint，refresh/backfill交替；事务一致读及SSE当代快照 |
| P5 | 完成 | 98项API观察、7组CLI、5项故障/退出回归和42项浏览器E2E通过 |
| P6 | 完成 | 四平台原生与八组npm安装；实际安装文件36样本等价；保留emoji查询的一致性读取取舍；主包权限规范化及严格集合校验 |
| P7 | 完成 | Rust唯一后端；旧Core/CLI/Worker移除；生成契约、默认脚本、CI/发布配置与文档切换 |

最终实现和边界详见[汇总报告](rust-migration-completion.md)。

## 参考与复现

`tests/reference/manifest.json` 记录固定参考与摘要，`tests/reference/package-lock.json` 锁定已发布 `codesesh@1.0.12` 的安装依赖。参考制品位于忽略的 artifacts 目录，仅供差分测试，不进入产品运行路径。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm prepare:reference
pnpm test:backend
pnpm test:backend:full
pnpm test:migration
node --test tests/backend-contract/cli-options.test.mjs tests/backend-contract/lifecycle.test.mjs
pnpm test:rust:slice
pnpm test:e2e
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

进程比较默认运行当前 Rust release。输入隔离所有 Agent 根、home、用户状态、缓存和日志；预置价格缓存。CLI/HTTP 比较完整结构、值、顺序、业务时间戳与游标，只归一化已登记的随机进程字段。参考运行与候选运行不共享正在使用的可写数据库。

## 已修复的差异

- 保留 Node 的小数文件时间、JSON数值/字段顺序及消息游标链。
- 保持摘要原始记录计数与详情规范化消息计数的区别。
- 读取期间固定同一 SQLite 事务，避免旧 heads 与新 facts 混合。
- SSE 合并数值进度、保留里程碑；慢连接预算有界，信号退出关闭现有流。
- 热JSON按来源库存、定价代际及项目身份签名复用，变化时失效；过滤不截断持久缓存。
- 损坏派生缓存降级到临时库且保留原文件；损坏用户state不阻止浏览，状态API明确失败。
- 恢复可信代理Host行为、gzip/deflate、CLI错误输出、JSON退出日志与fatal日志。
- 详情保留旧版的模型用量和来源签名字段；公开列表/SSE继续使用原有字段投影。

## 性能与平台记录

[Node P0基线](benchmarks/rust-migration-node-p0.json)用于验证测量工具。
[修复前报告](benchmarks/rust-migration-p6-before.md)保留失败与回退样本。
[最终配对报告](benchmarks/rust-migration-p6-final.md)绑定实际安装的arm64二进制：
3个场景各预热1轮、正式5轮，36个完整样本无结果差异；热JSON耗时为Node的11%～16%，
稳态RSS为13%～22%。600会话emoji搜索p95从2.15ms升至5.46ms，已定位并保留同事务
读取会话头的一致性成本，未宣称所有查询均提速。

支持macOS arm64/x64、Linux x64 GNU（glibc2.35+）及Windows x64 MSVC。
四平台安装与Node22.0.0/24组合均有实跑记录；最终CI与哈希报告随汇总包保存。
npm发布权限和公开渠道安装属于P8；本轮未执行发布、创建tag或合并。
