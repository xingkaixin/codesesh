# 性能验证

Rust 后端的性能需要实际测量。语言、静态链接或单一可执行文件都不能直接证明吞吐、启动
耗时或内存改善。每份结果应记录 commit、工具链、平台、CPU、样本规模、缓存状态及测量次数。

## 不设性能门禁

CI 不运行性能预算、bundle 大小或增长率检查。性能问题用下列基准手动测量后再决定是否处理。

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
```

增长率检查用于发现规模扩大后的数量级退化；浏览器基准用于观察首屏、导航和详情渲染。
两者不能互相替代。浏览器基准使用本机历史时，报告必须说明会话数、消息数、最大单会话
大小和冷暖缓存状态，且不要把本机数据提交到仓库。

后端脚本读取原生二进制时，需要先完成 Web 构建和 Rust
release 构建；debug-only 跳过资源打包不能作为可发布制品的性能结果。

## API 热点排查

使用 Node 24 和当前 release 构建：

```bash
pnpm build
pnpm bench:api --runs=5 --days=7
pnpm bench:api --runs=5 --days=0 --output=artifacts/api-hotspots/all-history.json
pnpm bench:api --base=/path/to/before --binary=/path/to/after --runs=5
```

脚本默认以只读连接打开 `~/.codesesh/codesesh.db`，通过 SQLite Backup API 复制到临时目录，
同时复制用户状态、定价和已有 Hub 身份。测量在隔离的 Hub 进程中运行，不采集来源、不连接
Worker。临时副本在结束时删除；复制时间不计入请求耗时。可用 `--database=<path>` 选择来源，
`--binary=<path>` 选择已构建的二进制，`--snapshot=<directory>` 复用已有的隔离目录。

请求复用前端时间窗口解析，覆盖首页并发请求、完整会话列表分页、全文搜索和最多 200 条消息
的详情页。每轮重启进程，先测聚合缓存未命中，再测命中；操作系统页缓存不清除。先执行一轮
预热，保留全部原始样本，并校验列表条数、唯一性、详情范围与 HTTP 状态。

报告区分响应头、完整响应体和客户端 JSON 解析耗时。`coreReadyMs` 仅表示首页核心 API 完成，
不包含 React 渲染，也不等待未匹配模型统计。CPU 和 RSS 属于整个后端场景，不能当作并发场景
中某个请求独占的资源；RSS 是采样峰值，非操作系统高水位。会话头消息数与实际存储消息条数
分别记录，不混用。

`--base` 启用成对对照，每轮交替先后顺序。两个版本共用冻结数据与时间窗口；报告记录
二进制及脚本 SHA-256。完整业务响应按对象键排序后计算摘要，数组顺序保留；会话与项目
列表分别用各自游标完整遍历后比较，不比较进程随机生成的游标标识。配置响应不参与业务
等价比较；全历史 Dashboard 的结束时间固定在实验开始时。摘要计算与项目后续分页在计时
区间外执行，任何业务结果差异都会使命令失败。脚本保留原始配对，不自动给出性能门禁判定。

先按绝对耗时、调用频率、用户等待和总资源开销筛选路径，再单独采样。Strobe 可从项目外按
PID 采集原生调用栈，无需注册 MCP 或后台服务：

```bash
bunx @hona/strobe@0.44.0 status --fast
bunx @hona/strobe@0.44.0 record pid:<PID> --probes deep --for 12s
bunx @hona/strobe@0.44.0 query <rec_id> hotspots --top 15
```

Rust 函数归因需要保留符号。先完成 Web 构建，再设置
`CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=false` 运行 release 构建。
采样与正式计时分开；macOS 原生采样是调用栈计数，不能转换成函数耗时。`http.request` 日志
止于响应对象返回，流式列表和详情还需检查完整响应耗时。`perf.query` 可用 `request_id` 关联
Dashboard、Projects 的缓存命中和分阶段计时。

结果默认写入被 Git 忽略的 `artifacts/`，只记录计时和计数，不保存响应内容。真实历史的原始
数据和缓存副本不提交到仓库。此命令用于手动诊断，不设置 CI 性能门禁。

## 性能结论的边界

- 与固定版本比较时，必须记录双方版本和相同工作负载。
- SQLite 文件大小、WAL 和进程 RSS 是不同指标，应分别报告。
- 先确认响应、消息数、成本和增量游标一致，避免把漏解析当成提速。
- 发布前应在目标平台运行，而不只验证交叉编译成功。
- 历史 TypeScript 微基准属于对应历史 commit，不能沿用为 Rust 实现的测量结果。
