# OpenCode V2 兼容设计

## 目标与基线

保留现有 OpenCode 身份，在会话列表、项目、搜索、Dashboard、书签和会话树中
浏览 OpenCode V2 的本地历史。支持用户输入、助手正文、思考、工具、附件引用、
子会话和上下文压缩记录，沿用 `opencode -s <sessionId>` 恢复命令。

实现基线为上游 `anomalyco/opencode` 的 `2.0.15`、提交 `88a9688`。
依据为上游 session/sql.ts、schema/session-message.ts、database/v1-migration.bun.ts
和 cli/database-path.ts。测试使用按该协议构造的 SQLite 文件；不将合成样本
等同于真实账号、远程服务或所有历史开发版本的兼容认证。

本次只读取落盘数据，不启动 OpenCode、不调用会触发迁移的 SDK、不写入源数据库。
不新增公共消息类型、数据库 schema、HTTP API 或运行时依赖。
保留 V1 的 session/message/part 读取路径及 ZCode 行为。

## 用户行为

1. 默认发现本地数据库后，仍在同一个 OpenCode 筛选项下展示会话。
2. 标题为空时使用第一条普通用户文本；没有可见消息的空会话不进入列表。
3. 归档历史仍可浏览。时间窗口选择根会话，再纳入关联后代；孤立子会话按自身时间选择。
4. 子任务通过 parent_id 进入会话树；fork 是独立会话，不能当作子任务重复累计。
5. 消息按 seq 排序，保留 content 数组中的正文、思考和工具交错顺序。
6. 工具流式参数与运行状态显示为运行中，成功和失败保留各自输出。
7. 数据库及 WAL 落盘变化触发刷新；旧消息更新、删除或工具完成使详情和搜索重新物化。
8. 迁移未完成或读取失败时报告扫描失败，保留已有缓存；不能用空列表覆盖历史。

## 路径发现与监听

一个实例读取一个数据库，避免不同渠道或数据库副本重复出现相同会话 ID。

- 明确指定 sourceRoot 时只读取该目录下的 opencode.db，不受环境变量覆盖。
- 否则使用 OPENCODE_DB：绝对路径直接读取，相对路径相对于 OpenCode 数据目录解析。
  显式路径不存在时不回退；`:memory:` 不属于可读取的历史来源。
- 默认数据目录遵循上游 XDG_DATA_HOME/opencode，未设置时为
  ~/.local/share/opencode，包括 Windows。保留现有 data/opencode/opencode.db 开发回退。
- 自定义渠道文件通过 OPENCODE_DB 指定；不枚举并合并所有 opencode-*.db。
- 监听和读取使用相同候选路径。复用现有 pollForChanges 轮询数据库、WAL、journal，
  排除 SHM；没有变化时不查询数据库。恢复命令要求终端使用相同的数据路径环境。

## V1/V2 选择与迁移

使用数据库表结构判断，不能依赖会话 version 字符串：迁移会保留旧会话版本。

| 数据库情况 | 行为 |
| --- | --- |
| 无 session_v2、无 session_message | 沿用 V1 读取 |
| 存在 session_v2 | 校验并读取 session_v2/session_message |
| V1 表为空或不存在 | 直接读取 V2 |
| V1 有数据且 kv 中 migration.v1-v2.phase 为 completed | 只读取 V2 |
| V1 有数据但迁移尚未完成 | 扫描失败，等待后续刷新，不拼接部分迁移结果 |
| 只有旧开发版 session_message、没有 session_v2 | 不支持的 schema，报告失败 |

V2 迁移完成后不回退单个缺失会话到 V1。这样不会让 V2 已删除的会话从遗留表复活，
也不会展示迁移前的过期标题和消息。schema 或外层消息 JSON 损坏同样报告失败。
所有相关查询置于只读事务，避免一次扫描混入迁移前后的数据。

## 会话与消息映射

会话 ID、标题、directory、time_created/time_updated、version、summary_files
沿用现有字段。directory 是上游 Location 根目录；path 是相对于该根目录的项目子路径，
不将 path 当成新的执行目录。parent_id 映射为 parent_reference，fork_session_id 不映射。

| V2 类型/字段 | 展示契约 |
| --- | --- |
| user.text | 普通 user/text |
| user.files | 内联图片映射现有 image；其他附件保留名称、类型、来源引用 |
| user.agents / user.skills | 保留提及名称，不执行技能内容 |
| assistant.content text/reasoning | 对应 text/reasoning |
| assistant.content tool | name → tool，id → callID，state.input → input |
| tool.state.content | 文本输出及文件引用；不读取引用文件或自动下载远程内容 |
| tool.state.error / metadata | 保留错误和元数据；streaming → running |
| assistant.model | id/providerID → model/provider；不把当前会话模型倒填到历史 |
| assistant.error | 显示错误，即使没有正常正文 |
| synthetic / system / skill | 带 mode 的自动消息；不用于用户标题兜底 |
| shell | 命令工具卡片，保留输出、退出码、截断状态及 shellID |
| compaction | 带标签的摘要、recent、状态及错误，mode 为 compaction |
| agent/model/location-switched | 带标签的切换记录，不伪装成人类输入 |
| idle | 内部执行边界，不单独展示 |
| 未知类型/内容 | 保留标签和原始可序列化内容，避免静默丢失 |

工具名字保持原样，未知工具使用通用卡片。Web 为 shell 复用命令显示，edit 支持
path + oldString/newString 的 diff，并保留失败时的错误显示。read/write/glob/grep/skill
沿用已有展示能力。subagent 结果有明确且唯一的 metadata.sessionID 时关联子会话。

## 用量与费用

session_v2 的 cost 和 tokens_* 是会话总量的唯一来源：

- cost 保留明确的 0，不将免费请求误判为待估算费用。
- input/output/reasoning/cache_read/cache_write 映射现有字段，total_tokens 为这些独立量之和。
- 会话统计不再累加消息费用，也不把子会话总量加到父会话。
- fork 会复制原消息，但其会话用量从 0 起算；不能把复制历史计入新会话费用。
- 压缩、重试或撤回后的累计用量可能无法从可见消息重新计算，仍以会话记录为准。
- 消息保留自身记录的 tokens/cost 供查看；缺失值保持未知，不根据当前模型猜测。
- 按模型用量只在消息用量合计与会话总量一致、且各用量均有明确模型时提供。
  不一致时保留会话总量和消息模型，省略不可靠的模型分摊。

## 同步与模块边界

沿用 OpenCodeSqliteAgent 的 V1 读取。仅 OpenCode 配置启用 V2，ZCode 不启用。
V2 的数据库读取和消息转换分别放入独立文件，不把新版字段判断散布到 UI 和公共模型。

扫描先读取会话元数据并选择根及后代，再按批读取选中会话消息，避免逐会话 N+1 查询。
扫描逐行转换、统计消息数并计算指纹，不保留所有历史消息数组；详情只保留目标会话。
时间窗口使用现有 from/to 语义，包含边界。循环父链接不得造成无限遍历。

sourceFingerprint 覆盖会话源字段、按 seq 排序的消息内容和解析器版本。
即使时间戳、字节长度和消息数不变，原地修改也必须使详情版本变化。
升级解析器后失效旧 OpenCode 缓存；延续现有 append/reset、索引和失败重试机制。
旧解析器可能留下没有任何会话版本信息的空缓存，因此每次启动首次遇到空基线时
强制刷新一次，成功提交后再按数据库指纹跳过无变化扫描；失败时继续保留重试资格。
这是文件变化后的批量重扫，不宣称只读取新增消息。

## 验收与实施提交

先提交本设计，再提交 Core 兼容实现与回归测试，最后提交 Web 展示与用户文档。

必要验证覆盖以下对外行为：

- V2 全新库和 V1/V2 共存库可正确读取；迁移中保留缓存；完成后不复活旧会话。
- V1 与 ZCode 原有测试保持通过；纯旧开发版 schema 明确失败。
- seq 顺序、标题兜底、归档、时间窗口、子任务、孤立子会话和独立 fork 正确。
- 文本、思考、工具各状态、错误、附件、系统记录、压缩和未知内容可读。
- 明确零费用、缓存/推理 token、fork、子会话、压缩的统计不重复。
- WAL 写入可检测；等长修改、删除、用量变化使指纹变化；无变化会话指纹稳定。
- 数据库读取前后字节一致；损坏 JSON/schema 不能伪装为无会话。
- 路径优先级、相对/绝对 OPENCODE_DB、内存库和不存在的显式路径符合设计。
- Web 命令、edit diff、错误和未知工具回退正确。

执行相关 Core/Web 测试、类型检查，再运行全仓 lint、format、build、单测、覆盖率与必要
端到端检查。PR 使用英文，检查所有 CI、审查结果与冲突状态，通过后按授权 squash merge。
