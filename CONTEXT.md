# CodeSesh

CodeSesh 将多个本地 AI Coding Agent 的原生历史记录归一为可统一发现、检索和浏览的会话。

## Language

**Agent**:
产生并持有原生编码会话历史的本地 AI 编码工具。
_Avoid_: Provider, source type

**Session Source**:
Agent 持有的一份原生会话记录；它可以是文件、目录或数据库中的记录。
_Avoid_: Transcript file

**Session Source Access**:
Agent 核对原生 Session Source 的行为能力。`enumerated` 可逐一枚举、指纹比较和解析
Session Source；`aggregate` 只能先检查整体存储是否变化，再重扫受影响的数据。
_Avoid_: Agent class type, storage class

**Session**:
由一个 Agent 产生、经 CodeSesh 归一化后可统一浏览的一段编码对话。
_Avoid_: Conversation, chat

**Session ID**:
Agent 在自身命名空间内为 Session 提供的不透明标识；它必须与 Agent 组合后才能唯一定位 Session。
_Avoid_: Session slug, global session ID

**Session Reference**:
在 CodeSesh 中唯一标识 Session 的复合身份，由 Agent 与该 Agent 内不透明的 Session ID 共同构成；Session ID 本身不全局唯一，也不应被拆解解释。
_Avoid_: Session slug, session path

**Session Hierarchy**:
由 Session Reference 与 `parent_reference` 表达的 Session 亲子关系；无法抵达根节点的缺父或成环 Session 仍作为未挂载条目保留。
_Avoid_: Session Tree, parent-child graph

**Session Head**:
用于列表、分组、搜索和统计的轻量 Session 摘要，不包含完整消息正文；其中的统计只归属于该 Session，不包含 descendant Session 的汇总。
_Avoid_: Session metadata

**Inclusive Session Stats**:
从 Session Hierarchy 派生的统计汇总，包含目标 Session 与每个可挂载 descendant Session 恰好一次。
_Avoid_: Session stats, parent stats

**Session Detail**:
包含完整归一化消息与工具活动、可用于回放 Session 的详细内容。
_Avoid_: Full session, transcript

**Project Identity**:
将不同 Agent 中属于同一代码项目的 Session 聚合起来的复合身份，由 kind 与 key 共同构成。
_Avoid_: Project path, bare project key

**Project Group**:
按同一 Project Identity 聚合的一组 Session Head，用于跨 Agent 浏览同一个项目。
_Avoid_: Project folder, workspace

**Live Snapshot**:
CodeSesh 当前已发布、可供查询和浏览的一组 Session Head 及其派生统计。
_Avoid_: Cache, session list

**Session Alias**:
用户为一个 Session Reference 指定的显示名称；它只改变展示，不改变 Session 的身份。
_Avoid_: Session title, nickname

**Bookmark**:
用户标记为稍后访问的 Session；它的身份始终由 Session Reference 决定。
_Avoid_: Favorite, bookmarked session snapshot

**Smart Tag**:
CodeSesh 根据 Session 内容自动归纳、用于筛选的一项工作类型分类。
_Avoid_: Label, manual tag

**File Activity**:
Session 中对文件路径发生的读取、编辑、写入或删除活动的归一化汇总。
_Avoid_: File change, tool call
