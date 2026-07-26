# CodeSesh

CodeSesh 将多个本地 AI Coding Agent 的原生历史记录归一为可统一发现、检索和浏览的会话。

## Language

**Agent**:
产生并持有原生编码会话历史的本地 AI 编码工具。
_Avoid_: Provider, source type

**Session Source**:
Agent 持有的一份原生会话记录；它可以是文件、目录或数据库中的记录。
_Avoid_: Transcript file

**Session**:
由一个 Agent 产生、经 CodeSesh 归一化后可统一浏览的一段编码对话。
_Avoid_: Conversation, chat

**Session Reference**:
在 CodeSesh 中唯一标识 Session 的复合身份，由 Agent 与该 Agent 内不透明的 Session ID 共同构成；Session ID 本身不全局唯一，也不应被拆解解释。
_Avoid_: Bare session ID, session slug

**Session Head**:
用于列表、分组、搜索和统计的轻量 Session 摘要，不包含完整消息正文。
_Avoid_: Session metadata

**Session Detail**:
包含完整归一化消息与工具活动、可用于回放 Session 的详细内容。
_Avoid_: Full session, transcript

**Project Identity**:
将不同 Agent 中属于同一代码项目的 Session 聚合起来的复合身份，由 kind 与 key 共同构成。
_Avoid_: Project path, bare project key

**Live Snapshot**:
CodeSesh 当前已发布、可供查询和浏览的一组 Session Head 及其派生统计。
_Avoid_: Cache, session list
