---
layout: ../../../layouts/SessionHistoryLayout.astro
locale: zh
---

CodeSesh 可以搜索和回放仍保存在本机的 Claude Code 与 Codex 对话。它读取受支持的本地记录，按项目组织会话，并搜索消息、工具输出和文件路径。无需上传历史，也不需要注册账号。

## 1. 启动本地查看器

安装 Node.js 22 或更高版本，然后在终端运行：

```sh
npx codesesh --days 0
```

CodeSesh 会打开 `http://localhost:4521`。如果端口被占用，请使用终端中打印的地址。浏览期间保持终端进程运行。

**为什么加 `--days 0`？** 默认命令 `npx codesesh` 只包含最近七个本地日历日内活跃的会话。查找更早的对话时，使用 `--days 0`。历史记录较多时，首次扫描和搜索索引需要一些时间。

## 2. 确认历史记录存在哪里

CodeSesh 默认读取以下位置。`~` 代表当前用户的主目录：

- **Claude Code：** `~/.claude/projects/` 下的 JSONL 会话记录。如果设置了 `CLAUDE_CONFIG_DIR`，则读取该配置根目录下的 `projects/`。
- **Codex：** `~/.codex/sessions/` 下的 `rollout-*.jsonl`，包括按日期嵌套的子目录。如果设置了 `CODEX_HOME`，则读取该根目录下的 `sessions/`。

启动 CodeSesh 的终端应使用与编码工具相同的环境变量。这两个变量指向工具的根目录，不是直接指向 `projects/` 或 `sessions/`。

当前 Codex 适配器默认不扫描 `~/.codex/archived_sessions/`。仅保存在另一台电脑或托管服务中的对话，也不属于这次本地扫描的范围。

## 3. 按项目和内容找回一次对话

假设你记得在 `my-app` 仓库中修过登录超时，但忘了当时用的是 Claude Code 还是 Codex：

1. 打开全局搜索，输入对话中出现过的词句，例如 `登录超时`。请使用你真实记录里的文字；这里的词句只是操作示例，不是内置会话数据。
2. 用项目筛选缩小结果范围。如果记得使用的工具，再通过 Agent 筛选选择 Claude Code 或 Codex。
3. 不记得原话时，尝试文件路径，例如 `src/auth.ts`。搜索可以匹配已索引的文件路径、工具输出和对话正文。
4. 打开匹配的会话，查看前后消息，展开工具调用以阅读当时的判断和输出。通过文件活动视图定位读取或修改过的文件。

也可以在项目目录中启动，让服务只显示该项目的会话：

```sh
npx codesesh --days 0 --cwd .
```

只查看这两种 Agent 时，可以运行：

```sh
npx codesesh --days 0 --agent claudecode,codex
```

回放是查看已记录的对话和工具活动，不会重新执行命令或恢复当时的文件系统。可以先查看[搜索与会话回放演示](/zh/#tour)，了解界面。

<h2 id="troubleshooting">4. 找不到会话时怎么排查</h2>

- **先检查时间范围。** 使用 `--days 0` 重新启动，并清除界面中限制过严的筛选。如果 `--from`、`--to`、`--cwd` 或 `--agent` 排除了目标会话，也需要移除这些参数。
- **确认源文件仍存在。** 检查对应的本地目录及当前用户的读取权限。Codex 会话还需确认是否已被移到 `archived_sessions/`。
- **检查自定义根目录。** 确认启动 CodeSesh 的终端能读取 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`，尤其是编码工具从另一种 Shell 或应用启动时。
- **等待索引完成。** 首次历史回填和搜索索引在后台进行。会话列表已经显示，不代表所有旧消息都能立即被搜索到。
- **反馈可复现的解析问题。** 如果受支持的记录确实存在但仍未出现，可以[提交问题](https://github.com/xingkaixin/codesesh/issues)，附上 CodeSesh 版本、Agent 和相关错误。分享前移除私人提示词、路径和凭据。

## 5. 了解本地索引的边界

CodeSesh 是查看器和搜索索引，不是原始会话文件的备份。它不能恢复已从 Agent 存储中删除的历史。`--json` 输出的是会话元数据，不包含完整消息和工具调用存档。

需要保留历史时，请保存 Agent 的原始数据。其他受支持的工具和产品能力可在 [CodeSesh 产品介绍](/zh/)中查看。
