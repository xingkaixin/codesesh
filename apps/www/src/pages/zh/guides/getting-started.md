---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: getting-started
---

CodeSesh 在本机打开一个 Web 界面，用来浏览 Claude Code、Codex 等受支持工具的历史会话。可以用一条命令试用，也可以安装独立可执行文件。电脑上需要已有会话记录；CodeSesh 不会替你创建编码对话。

## 选择安装方式

已经安装 Node.js 22 或更高版本时，可以先直接运行：

```sh
npx codesesh
```

如果经常使用，在 macOS、Linux 或 Windows 上安装全局命令：

```sh
npm install --global codesesh
codesesh --version
codesesh
```

不想依赖 Node.js 时，macOS 和 Linux 可以使用原生安装脚本：

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | sh
```

脚本会下载对应平台的可执行文件。Windows 用户也可以从 [GitHub Releases](https://github.com/xingkaixin/codesesh/releases) 下载原生压缩包。选择与你的操作系统和 CPU 架构对应的制品；独立可执行文件不需要 Node.js。

## 打开本地界面

启动后，CodeSesh 会打印访问地址，通常也会自动打开浏览器。默认地址为 `http://127.0.0.1:4521/`；如果程序选择了其他端口，以终端输出为准。浏览时保持终端运行，按 Ctrl+C 停止前台服务。

默认只有本机可以访问。如果本机也需要令牌验证，使用 `codesesh --auth`，并打开它打印的链接。需要从另一台设备访问时，参阅[局域网访问指南](/zh/guides/lan-access/)。

## 选择要显示的历史范围

默认显示最近七个本地日历日内活跃的会话。查找较早的对话时，使用全部历史：

```sh
codesesh --days 0
```

在项目目录中运行以下命令，可以限制项目和 Agent：

```sh
codesesh --cwd . --agent claudecode,codex --days 0
```

按固定日期查询时，输入本地日历日期：

```sh
codesesh --from 2026-09-01 --to 2026-09-30
```

显式指定 `--from` 会覆盖默认的天数窗口。大量历史记录首次建立索引需要时间。来源目录、搜索操作和缺失排查见[历史会话查找指南](/zh/guides/session-history/)。

## 选择单机模式还是 Hub 模式

`codesesh` 在一个进程中采集本机并提供 Web 界面。Hub 负责查询已保存的数据，Worker 负责采集与上传。需要统一浏览多台电脑时，使用 [Hub 和 Worker](/zh/guides/multi-machine-sync/)；需要关闭终端后继续运行时，参阅[后台服务指南](/zh/guides/background-services/)。

对同一数据目录切换模式前，先停止原来的单机 CodeSesh 进程。不要让单机模式与 Hub/Worker 同时使用该目录。
