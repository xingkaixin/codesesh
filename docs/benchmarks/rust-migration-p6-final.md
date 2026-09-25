# Rust P6 同机配对性能记录

最终安装候选源码 `91766747`，实际运行 binary SHA256 `c82c438bd465f667a10e4375f21895520405d090d62421e20ca0528504fb65f1`。平台 npm tgz 解包后的原生文件与 manifest 匹配。3 场景各 5 正式轮，合计 36 个含预热后端样本；稳定发布后的全字段等价和执行错误均为 0。

项目与 Dashboard 聚合、普通搜索的旧回退已消除。唯一剩余筛查项是 600 会话的 emoji 搜索：p50 1.42→4.62ms，p95 2.15→5.46ms。独立分段诊断定位到 Rust 每次同事务读取 600 个 head 的一致性快照约 3.4ms。这里保留一致性读取，明确登记约 3.3ms 的 p95 额外延迟；不宣称全项加速，也不修改阈值或原始样本。计划第 313 行要求没有未解释的明显回退，`1.2×` 只是本报告的诊断筛选线。

阶段：final-installed-candidate。生成：2026-09-25T10:22:48.100Z。

机器：Apple M1 Pro / darwin 27.0.0 / arm64；Node v24.21.0。每场景预热 1 次，正式 5 次；每轮每端点 30 个请求。

冷启动仅指删除应用 SQLite 缓存，未清空 OS 页缓存。正式测量期间暂停团队构建与重测试，系统后台负载未隔离。Web RSS 峰值为 200ms 采样最大值；CLI 峰值来自 OS high-water。时间均为墙钟；CPU 原始样本单独保存。

完整记录及原始样本：[JSON](rust-migration-p6-final.json)。完整 JSON 等价错误及执行错误共 0 项，保留在 errors；有错误时本报告不构成验收通过。

| 工作负载 | 指标 | Node | Rust | Rust/Node |
| --- | --- | ---: | ---: | ---: |
| mixed-small | versionWallMs | 99.50 | 9.09 | 0.091 |
| mixed-small | helpWallMs | 98.74 | 8.79 | 0.089 |
| mixed-small | idleCpuMs | 0.00 | 0.00 | 缺失 |
| mixed-small | coldJsonWallMs | 254.66 | 63.71 | 0.250 |
| mixed-small | coldJsonCpuMs | 290.00 | 40.00 | 0.138 |
| mixed-small | warmJsonCpuMs | 180.00 | 0.00 | 0.000 |
| mixed-small | warmJsonWallMs | 168.97 | 19.67 | 0.116 |
| mixed-small | coldJsonPeakRssBytes | 124469248.00 | 23625728.00 | 0.190 |
| mixed-small | coldWebHttpReadyMs | 148.66 | 28.62 | 0.193 |
| mixed-small | coldWebIndexedReadyMs | 297.02 | 56.43 | 0.190 |
| mixed-small | hotWebHttpReadyMs | 143.94 | 35.82 | 0.249 |
| mixed-small | steadyRssBytes | 204308480.00 | 32161792.00 | 0.157 |
| mixed-small | sampledPeakRssBytes | 210321408.00 | 32161792.00 | 0.153 |
| mixed-small | appendVisibleMs | 1041.03 | 179.61 | 0.173 |
| mixed-small | appendPublishedMs | 1043.45 | 180.48 | 0.173 |
| mixed-small | listP50WallMs | 1.04 | 0.54 | 0.518 |
| mixed-small | listP95WallMs | 1.44 | 0.97 | 0.676 |
| mixed-small | searchP50WallMs | 3.25 | 3.09 | 0.953 |
| mixed-small | searchP95WallMs | 4.48 | 3.95 | 0.880 |
| mixed-small | searchUnicodeP50WallMs | 3.29 | 2.91 | 0.883 |
| mixed-small | searchUnicodeP95WallMs | 4.38 | 3.65 | 0.833 |
| mixed-small | detailP50WallMs | 1.65 | 0.79 | 0.478 |
| mixed-small | detailP95WallMs | 2.69 | 1.19 | 0.444 |
| mixed-small | searchEmojiP50WallMs | 1.37 | 0.96 | 0.702 |
| mixed-small | searchEmojiP95WallMs | 2.23 | 1.85 | 0.830 |
| mixed-small | projectsP50WallMs | 0.99 | 0.43 | 0.431 |
| mixed-small | projectsP95WallMs | 1.67 | 0.71 | 0.426 |
| mixed-small | dashboardP50WallMs | 1.32 | 0.55 | 0.420 |
| mixed-small | dashboardP95WallMs | 1.97 | 0.87 | 0.442 |
| mixed-history | versionWallMs | 111.34 | 9.80 | 0.088 |
| mixed-history | helpWallMs | 101.51 | 10.01 | 0.099 |
| mixed-history | idleCpuMs | 0.00 | 0.00 | 缺失 |
| mixed-history | coldJsonWallMs | 1746.45 | 1322.19 | 0.757 |
| mixed-history | coldJsonCpuMs | 3130.00 | 1250.00 | 0.399 |
| mixed-history | warmJsonCpuMs | 250.00 | 20.00 | 0.080 |
| mixed-history | warmJsonWallMs | 207.73 | 33.76 | 0.163 |
| mixed-history | coldJsonPeakRssBytes | 319700992.00 | 87982080.00 | 0.275 |
| mixed-history | coldWebHttpReadyMs | 143.58 | 29.21 | 0.203 |
| mixed-history | coldWebIndexedReadyMs | 2011.24 | 1105.89 | 0.550 |
| mixed-history | hotWebHttpReadyMs | 154.88 | 55.00 | 0.355 |
| mixed-history | steadyRssBytes | 452657152.00 | 101187584.00 | 0.224 |
| mixed-history | sampledPeakRssBytes | 469319680.00 | 101498880.00 | 0.216 |
| mixed-history | appendVisibleMs | 7943.86 | 192.93 | 0.024 |
| mixed-history | appendPublishedMs | 7945.66 | 194.26 | 0.024 |
| mixed-history | backfilllistP50WallMs | 2.17 | 2.03 | 0.937 |
| mixed-history | backfilllistP95WallMs | 3.61 | 3.36 | 0.930 |
| mixed-history | backfillsearchP50WallMs | 15.48 | 13.15 | 0.849 |
| mixed-history | backfillsearchP95WallMs | 490.23 | 16.58 | 0.034 |
| mixed-history | backfilldetailP50WallMs | 50.30 | 1.39 | 0.028 |
| mixed-history | backfilldetailP95WallMs | 51.11 | 1.80 | 0.035 |
| mixed-history | listP50WallMs | 4.39 | 3.28 | 0.746 |
| mixed-history | listP95WallMs | 5.38 | 4.17 | 0.775 |
| mixed-history | searchP50WallMs | 14.63 | 13.71 | 0.937 |
| mixed-history | searchP95WallMs | 16.19 | 15.60 | 0.963 |
| mixed-history | searchUnicodeP50WallMs | 14.35 | 12.50 | 0.871 |
| mixed-history | searchUnicodeP95WallMs | 16.51 | 13.88 | 0.841 |
| mixed-history | detailP50WallMs | 1.92 | 1.18 | 0.617 |
| mixed-history | detailP95WallMs | 3.01 | 1.57 | 0.523 |
| mixed-history | searchEmojiP50WallMs | 1.42 | 4.62 | 3.252 |
| mixed-history | searchEmojiP95WallMs | 2.15 | 5.46 | 2.540 |
| mixed-history | projectsP50WallMs | 0.95 | 0.60 | 0.639 |
| mixed-history | projectsP95WallMs | 1.48 | 0.86 | 0.577 |
| mixed-history | dashboardP50WallMs | 1.28 | 0.65 | 0.511 |
| mixed-history | dashboardP95WallMs | 1.95 | 1.03 | 0.526 |
| large-single-file | versionWallMs | 109.80 | 9.05 | 0.082 |
| large-single-file | helpWallMs | 99.69 | 8.51 | 0.085 |
| large-single-file | idleCpuMs | 0.00 | 0.00 | 缺失 |
| large-single-file | coldJsonWallMs | 934.17 | 503.34 | 0.539 |
| large-single-file | coldJsonCpuMs | 1080.00 | 470.00 | 0.435 |
| large-single-file | warmJsonCpuMs | 190.00 | 0.00 | 0.000 |
| large-single-file | warmJsonWallMs | 175.69 | 19.56 | 0.111 |
| large-single-file | coldJsonPeakRssBytes | 363872256.00 | 53723136.00 | 0.148 |
| large-single-file | coldWebHttpReadyMs | 142.57 | 28.63 | 0.201 |
| large-single-file | coldWebIndexedReadyMs | 985.43 | 487.35 | 0.495 |
| large-single-file | hotWebHttpReadyMs | 168.23 | 54.72 | 0.325 |
| large-single-file | steadyRssBytes | 581058560.00 | 75399168.00 | 0.130 |
| large-single-file | sampledPeakRssBytes | 659439616.00 | 84787200.00 | 0.129 |
| large-single-file | appendVisibleMs | 4680.16 | 848.20 | 0.181 |
| large-single-file | appendPublishedMs | 4751.51 | 912.15 | 0.192 |
| large-single-file | listP50WallMs | 0.85 | 0.45 | 0.530 |
| large-single-file | listP95WallMs | 1.66 | 0.78 | 0.472 |
| large-single-file | searchP50WallMs | 14.76 | 14.43 | 0.977 |
| large-single-file | searchP95WallMs | 17.12 | 15.64 | 0.913 |
| large-single-file | searchUnicodeP50WallMs | 14.71 | 14.00 | 0.952 |
| large-single-file | searchUnicodeP95WallMs | 16.33 | 15.49 | 0.949 |
| large-single-file | detailP50WallMs | 55.08 | 48.69 | 0.884 |
| large-single-file | detailP95WallMs | 64.29 | 50.46 | 0.785 |
| large-single-file | searchEmojiP50WallMs | 2.24 | 1.55 | 0.694 |
| large-single-file | searchEmojiP95WallMs | 3.62 | 2.51 | 0.693 |
| large-single-file | projectsP50WallMs | 1.16 | 0.55 | 0.476 |
| large-single-file | projectsP95WallMs | 2.36 | 0.80 | 0.339 |
| large-single-file | dashboardP50WallMs | 1.29 | 0.55 | 0.424 |
| large-single-file | dashboardP95WallMs | 2.25 | 0.81 | 0.357 |

`regressionScreen` 仅标记比值 > 1.2 供定位，不是新设的验收阈值。计划未约定统一加速倍数；不得据此忽略较小回退。大文件详情样本包含响应体接收，未计 JSON.parse；端点 p95 使用所有请求样本。

未测项目：浏览器可交互时间、安装解压时间及Node完整传递依赖下载体积、查询计划、物理读写量、解析次数、SQLite独立首次索引、监听突发变化后的内存恢复、backfill队列深度和其中并发追加延迟，以及冷OS页缓存下的查询。混合历史另有独立清缓存 backfill 流量场景，duringBackfill 记录每次list/search/detail延迟与HTTP状态；未ready详情保留503。SQLite 写入引擎版本来自各后端缓存文件头；Node编译选项读取固定模块，Rust选项读取本机release静态构建归档代理，不声称来自安装后的CLI。

## 制品与覆盖边界

制品记录在 JSON packaging：原生二进制 18911888 bytes，内嵌 Web 构建输入 1797565 bytes；manifest 与候选 SHA 一致：true。Node 主包不含依赖与Node运行时，不能直接与Rust平台包比较完整安装成本。

appendVisibleMs 是首次消息 body 可见；appendPublishedMs 还要求 head.time_updated 达到追加事件时间且消息数一致。firstAppend 与 publishedAppend 原样记录两阶段 head、条数和完整摘要；完整等价断言在后者执行。诊断报告保留了 Node 首次 body 已新但 head 随后才发布的暂态，不对时间字段归一化。

Dashboard 请求覆盖 2026-09-01 至 2026-09-02 UTC，包含 activeHours；emoji查询针对fixture真实存在的 🔎。这是固定合成分布上的响应指标，不覆盖所有Agent或真实用户数据分布。

## 错误与回退

- mixed-history searchEmojiP50WallMs：Rust/Node 3.252，已定位为600 heads一致性快照读取成本，保留该取舍。
- mixed-history searchEmojiP95WallMs：Rust/Node 2.540，已定位为600 heads一致性快照读取成本，保留该取舍。
