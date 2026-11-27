---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: gemini-cli-session-history
---

Gemini CLI 将本地历史对话以 JSON 和 JSONL 文件形式保存在 `~/.gemini/tmp/<project-hash>/chats/` 目录下。如果设置了 `GEMINI_CLI_HOME`，则读取 `$GEMINI_CLI_HOME/.gemini/tmp/`。在终端恢复历史对话可运行 `gemini --resume`；要在本地 Web 界面中跨项目搜索消息、工具调用、思考过程与 Token 用量，运行 `npx codesesh --agent gemini-cli --days 0`。

## Gemini CLI 历史会话的保存位置

默认情况下，Gemini CLI 按项目哈希分目录存放本地对话文件：

- **会话文件：** `~/.gemini/tmp/<project-hash>/chats/*.json` 与 `*.jsonl`
- **自定义根目录：** 设置 `GEMINI_CLI_HOME` 替换 `.gemini/` 所在的父目录（CodeSesh 会扫描 `$GEMINI_CLI_HOME/.gemini/tmp/`）

由于 `~/.gemini/tmp/` 下的子目录名是项目哈希而非仓库名，直接在文件系统里翻找某个项目的历史对话很不直观。

## 在命令行恢复之前的 Gemini CLI 会话

在原项目目录中，可以直接使用 Gemini CLI 原生恢复参数：

```sh
gemini --resume
```

已知会话 ID（例如从 CodeSesh 复制）时，可运行 `gemini --resume <session-id>` 直接恢复。

## 用 CodeSesh 搜索和回放 Gemini CLI 历史

CodeSesh 以只读方式扫描 `~/.gemini/tmp/*/chats/`，还原项目归属并建立本地 SQLite 索引，让你无需手动翻阅哈希目录或原始 JSON 文件。

扫描本机全部 Gemini CLI 会话：

```sh
npx codesesh --agent gemini-cli --days 0
```

仅查看当前仓库的历史记录：

```sh
npx codesesh --agent gemini-cli --days 0 --cwd .
```

打开 `http://localhost:4521` 后，你可以：

- **跨项目全文搜索：** 直接搜索提示词、Gemini 回复、工具输出和文件路径，不必在哈希文件夹里逐个查找。
- **完整回放推理与工具调用：** 按时间顺序查看思考过程、工具参数、返回结果以及嵌套子会话。
- **查看 Token 与估算成本：** 按项目、模型和时间维度统计输入、输出、推理与缓存 Token。
- **一键复制恢复命令：** 在任意会话详情页直接复制 `gemini --resume <session-id>`。

## 找不到 Gemini CLI 会话时怎么排查

- **检查 `GEMINI_CLI_HOME`。** 该环境变量指向包含 `.gemini/` 的父目录，而不是直接指向 `.gemini/tmp/`。
- **加上 `--days 0`。** 默认命令只显示最近 7 天活跃的会话，查找更早历史请使用 `--days 0` 或在界面切换为「全部」。
- **注意 `tmp` 目录清理。** Gemini CLI 将记录存放在 `~/.gemini/tmp/` 下，手动清理该目录会永久删除源文件。CodeSesh 只读不改写原文件，也无法恢复扫描前已被删除的记录。

延伸阅读：[本地历史会话总览](/zh/guides/session-history/)、[Claude Code 历史会话指南](/zh/guides/claude-code-session-history/)、[Codex 历史会话指南](/zh/guides/codex-session-history/)。
