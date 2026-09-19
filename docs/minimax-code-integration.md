# MiniMax Code 接入设计

## 目标和支持范围

将 MiniMax Code 注册为独立 Agent：`minimax-code`，显示名为 `MiniMax Code`。
用户可以在现有会话列表、项目、搜索、Dashboard、书签和会话树中使用它，
打开历史消息和工具详情，并复制 `mcode --session <sessionId>` 恢复命令。
不需要启动 MiniMax runtime、登录账号或访问 MiniMax 云端。

实现基线为 CLI `@minimax-ai/code@0.4.12`，源码提交
[`81b666a10bb1bd097633b373679dbf399278b8d3`](https://github.com/MiniMax-AI/minimax-code/commit/81b666a10bb1bd097633b373679dbf399278b8d3)。
已静态核对 npm 发布包的主要路径和表结构；测试使用根据上游协议构建的脱敏样本，
不把源码核对等同于真实账号、Desktop 或全部历史版本的兼容认证。

首期不读取旧 ledger 布局，不迁移上游数据库，不拼接模型上下文快照，
不接入实时 runtime 事件流，不恢复已被上游删除的消息或附件。
自动刷新以已经落盘的完整消息为准，不承诺逐 token 回放。

## 用户行为

1. 默认扫描发现数据库后，Agent 筛选中出现 MiniMax Code。
2. 会话显示标题、工作目录、时间、消息数、模型用量与费用；归档会话仍可浏览。
3. 父子关系沿用现有会话树；子任务保留独立消息和费用，不在父会话重复累计。
4. 消息按上游行序排列，用户正文、思考、助手正文和工具调用分别展示。
5. 活动会话落盘后自动刷新。原有消息被修改或撤回时，详情执行 reset；
   只有已展示前缀完全不变时才 append。
6. 恢复命令沿用现有终端复制流程。自定义数据目录用户需要让 mcode 使用相同环境变量。

## 数据目录与发现

单次 Agent 实例读取一个数据根目录，优先级如下：

1. 现有 `AgentSourceOptions.sourceRoot`，供测试和程序调用明确指定。
2. `MINIMAX_DATA_DIR`。
3. `MAVIS_DATA_DIR`。
4. 默认候选 `~/.minimax`、`~/.minimax-code`，按顺序选择存在目标数据库的目录。

指定目录不存在时不回退其他用户数据。两个默认目录都有数据时优先 npm 目录，
可通过环境变量选择源码目录；不合并两个目录，以免复制数据库造成重复会话。
监听默认候选目录，使后创建的数据库也能被发现。仅存在安装目录不代表存在会话。

数据库相对路径为 `v2/sqlite/runtime-state.sqlite`。使用现有只读 SQLite 工具，
在只读事务内获取一致快照，读取后关闭连接，不调用上游具有迁移副作用的 repository。
监听数据库、WAL 和 journal，沿用现有防抖与写入稳定检测；忽略 SHM 的读取副作用。

## 权威数据与字段映射

### 会话

读取 `local_runtime_sessions` 的 columnar v3 字段：

| 源字段 | CodeSesh |
| --- | --- |
| `session_id` | 保留原始 sessionId，Agent 命名空间负责隔离 |
| `title` | 标题；为空时使用第一条人类输入，再使用现有兜底标题 |
| `workspace_dir` | directory，交给现有项目识别 |
| `parent_session_id` | 同 Agent 的 parent_reference |
| `created_at_ms` / `updated_at_ms` | 创建时间和最近活动时间 |
| `agent_name` | 消息中的内部 Agent 名称，不作为 CodeSesh Agent 身份 |
| `extra_data_json` | 仅解析必要字段；当前 effectiveModel 不倒填到全部历史消息 |

`record_json` 可能是旧运行时兼容占位符，不能用它决定标题、归档、隐藏状态或模型。
保留归档记录；隐藏根会话和内部 peek/cron/channel 记录不进入列表。
关联子任务可以为 hidden，仍通过父会话发现。时间窗口先选择根会话，再包含后代；
孤立子会话按自身时间选择，防止父记录删除后丢失历史。
无消息会话不展示。已存在但不兼容的 schema 作为扫描失败处理，保留已有缓存。

### 展示消息

读取 `local_runtime_message_rows`，按 `session_id, id` 排序。
`msg_id` 是稳定消息身份，`data_json` 是展示数据，表列提供时间、role、turn 和来源。

| 内容 | 处理 |
| --- | --- |
| `msg_content` | text |
| `thinking_content` | reasoning，放在对应助手正文之前 |
| `tool_calls` | tool；保留工具名、调用 ID、输入、输出和元数据 |
| `kind` | compaction/review 等事件以有标签的文本和 mode 保存 |
| `attachments` | 可用 HTTP(S) 图片 URL 预览；其他附件保留名称、类型、路径 |
| 系统产生的用户消息 | 有明确自动来源时设置 automated，不推测普通来源 |

工具状态 Preparing/Prepared/Start 映射为 running，Finished 为 completed，Failed 为 error。
结果中的 `isError` 或明确错误也用于判断失败。原始状态保留在工具 metadata。
工具参数/结果是 JSON 字符串；解析失败时保留原文，不丢弃整个会话。
损坏的外层消息 JSON 不能静默丢弃，应使本次扫描失败并保留缓存。
未知工具保留通用展示；未知消息 kind 保留标签和已有正文。
任务结果的 `details.sub_session_id` / `details.session_id` 可用于链接子会话，
只在一个消息能唯一确定子会话时设置 subagent_id。

模型上下文 `messages.jsonl`、display 副本和 SQLite 不合并。
这样避免把压缩后的模型上下文当成完整聊天历史，也避免一条消息展示多次。
上游主动剥离的内联媒体不尝试从任意本地路径自动读取；大工具输出保留原有截断说明和引用。

### 模型、token 和费用

以 `local_runtime_token_usage` 为统计来源，每个 usage 行计入一次：

- input/output/reasoning/cache_read/cache_write 映射到现有 token 字段。
- 总 token 包含这些独立计数；不再累加展示消息的 usage 或 context window。
- 按行的 model 汇总 model_usage，支持会话内更换模型和 BYOK。
- 有非负 `cost_usd` 时保留，包括明确的 0；缺失时调用现有模型定价估算。
- 估算失败保留未定价模型，沿用已有定价补全机制，不编造价格。
- 有明确 turn_id、该 turn 只有一个模型且存在普通助手消息时，将 turn 用量
  汇总附着到该 turn 最后一条普通助手消息，只附着一次。
- 缺少可靠关联或同 turn 多模型时，用量只保留在会话统计中，不伪造消息归属。
  这类记录的按消息/模型费用分布可能不完整，不能将整个会话当前模型用于补齐。
- usage 表存在但没有记录时视为用量未知，不从上下文窗口猜测；统计数值沿用现有零值表示。

## 同步、正确性与开销

复用 `DatabaseSessionSource`。数据库文件集合不变时跳过扫描；变化时读取会话、消息、
用量三个有序结果集，并为每个会话计算内容指纹。指纹覆盖源行内容与 parser version，
不能只使用 MAX(id)、COUNT 或会话更新时间。

扫描阶段逐行消费消息，不保留所有历史消息数组；详情阶段只保留目标会话消息。
数据读取和指纹计算为 O(会话数 + 消息字节数 + 用量数)，缓存物化仅处理变化会话。
不使用每个会话执行一组查询的 N+1 扫描，不读取或反复哈希媒体文件。
这是可靠的增量同步，不宣称源数据读取为 O(新增消息数)。

沿用现有 sourceFingerprint、detail version、搜索物化和 append/reset 协议。
工具状态原地更新、旧消息等长修改、消息删除、title 修改和 usage 更新都改变指纹。
扫描失败不能推进成功基线，不能把数据库读取错误当作空列表删除历史。

## 工具展示

新增专用 tool strategy，复用现有文件、搜索、命令、diff 和通用结果组件：

| 工具 | 展示 |
| --- | --- |
| read/write | 路径、文件正文或写入内容 |
| edit | file_path、old_string/new_string 的结构化 diff；兼容明确出现的 Pi edits 数组 |
| bash | 命令、输出、错误和后台任务 ID |
| grep/glob | 搜索表达式、路径和结果 |
| todowrite | 任务列表，保留取消状态的文字信息 |
| skill | 技能名及原始结果 |
| task / task_append / task_query / task_output / task_stop | 任务说明、task ID、子会话和结果 |
| ask_user | steps 中的问题、选项和已记录答案；不伪造等待后的用户答复 |
| mcp_invoke | 有 tool_name 时展示目标名称，同时保留 wrapper 参数和结果 |
| goal / memory / review / web / 媒体 / 其他插件 | 通用卡片保留工具名称、结构化输入输出 |

不因支持一个 Agent 新增公共消息类型或专门页面。文件操作名称和字段可复用现有文件活动统计。

## 实施位置和提交

1. 设计文档单独提交，保留上游基线、范围和验收标准。
2. Core 新增 adapter 和消息/用量转换，注册 catalog、runtime 和必要测试。
3. Web 新增 tool strategy、图标、展示测试，同步 README 和产品站支持列表。

保持现有公开接口、缓存 schema 和 HTTP API 不变。不新增运行时依赖。

## 验收

使用真实 SQLite 文件验证对外行为，而不是 mock 私有查询：

- columnar 元数据优先于误导性的 record_json；标题兜底、归档、时间窗口、父子会话正确。
- 正文、思考、工具成功/失败/运行状态、损坏参数、生命周期事件、附件、MCP 和子任务可读。
- usage 行只累计一次，缓存 token、不同模型、明确零费用和估算费用正确。
- 不改变源文件；WAL 写入能被检测；等长原地修改且时间不变时仍使 detail version 变化。
- 删除、撤回、模型/费用更新正确；未变化会话的内容指纹保持稳定。
- 指定路径、环境变量优先级和两个默认目录的选择正确。
- 不兼容 schema / 损坏消息导致扫描失败，不静默返回空历史。
- 工具展示覆盖 diff、任务列表、问答、MCP、错误与未知工具兜底。
- 注册完备性覆盖 Web/产品站图标和 tool strategy；文档事实检查一致。

先执行相关 Core/Web 测试和类型检查，再执行仓库 lint、format、build、完整单测与必要端到端验证。
提交 PR 后检查所有 CI、审查结果和冲突状态；通过后按用户授权 squash merge 并删除分支。
