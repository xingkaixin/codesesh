# Rust 迁移进度

范围：执行 [P0～P7](rust-migration-plan.md)，P8 发布不在当前任务内。

参考提交：`a545f543a554421b0576058c701ef2ac4190d62e`。分支：`feat/rust-rewrite`。

## 阶段状态

以下为本地集成状态。最终完成仍以同一候选版本的性能、四平台安装和 CI 验收为准。

| 阶段 | 状态 | 证据与剩余项 |
| --- | --- | --- |
| P0 | 完成 | npm 1.0.12 固定参考、integrity/lock、进程比较器拒错验证、Node 基线 |
| P1 | 本地验收通过 | 两 crate、Rust 工具链、Codex CLI/HTTP/游标、真实 React 浏览；最终四平台检查进行中 |
| P2 | 本地验收通过 | 13 个适配器、项目身份、来源增量、毫秒小数及完整消息/游标差分 |
| P3 | 本地验收通过 | schema 34/state 3；17 项迁移/往返/FTS恢复检查；搜索、统计、价格、别名和书签 |
| P4 | 本地验收通过 | 每批32来源单元，窗口/目标优先；持久checkpoint，refresh/backfill交替；事务一致读及SSE当代快照 |
| P5 | 最终复验中 | 98项API差分通过；5组CLI差分与5项故障/退出回归通过；流式详情及42项浏览器E2E最终复验进行中 |
| P6 | 最终复验中 | 本机原生/npm安装通过；热JSON缓存回退已修；正式配对性能、其余三个原生目标CI待完成 |
| P7 | 最终复验中 | Rust唯一后端；旧Core/CLI/Worker删除；独立生成契约、默认脚本、CI/发布配置及文档已切换；最终CI待完成 |

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

[Node P0基线](benchmarks/rust-migration-node-p0.json)仅用于验证测量工具。[修复前配对报告](benchmarks/rust-migration-p6-before.md)保留真实回退与等价错误，不作为最终通过证据。热缓存修复后的单轮筛查约为Node201ms、Rust42ms；最终报告需重新进行同机交替、多轮测量。

支持目标：macOS arm64/x64、Linux x64 GNU、Windows x64 MSVC。当前只有本机arm64的完整安装记录，其他目标须以远端CI实际运行结果补齐；不能用构建成功替代安装运行。npm发布权限与公开渠道安装属于P8，本轮不执行发布或合并。
