---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: background-services
---

`codesesh hub start` 和 `codesesh worker start` 会注册当前用户的后台任务，启动后可以关闭终端。Hub 提供 Web 界面，已配对的 Worker 负责采集。不带 `start` 的 `codesesh hub` 则保持前台运行。

## 准备已配对的 Hub 和 Worker

首次配置先按[多机同步指南](/zh/guides/multi-machine-sync/)安装并配对。Hub 单独运行只提供已保存历史，不会采集本机。同一数据目录切换到 Hub/Worker 前，先停止单机模式。

仅本机访问的 Hub 可以这样启动：

```sh
codesesh hub start
codesesh hub status
codesesh hub open
```

需要局域网访问时，首次启动使用[局域网指南](/zh/guides/lan-access/)中的完整参数。Worker 已配对后，不需要新令牌就能再次启动：

```sh
codesesh worker start
codesesh worker status
```

之前只在前台配对过的 Worker，可以复用保存的 Hub 地址和凭据。如果尚无后台配置，采集选项使用本次参数和默认值；需要限制范围时，请显式传入 `--agent`。

## 等待服务就绪

`start` 最多等待约十秒。初始化耗时较长时，会继续在后台进行。可以跟随状态：

```sh
codesesh hub status --watch
codesesh worker status --watch
```

按 Ctrl+C 只退出状态观察，不会停止后台任务。Hub 就绪后，`codesesh hub open` 可以打开控制台。Worker 已连接时，仍可能存在待上传积压。

## 重启或修改配置

普通重启使用：

```sh
codesesh hub restart
codesesh worker restart
```

重启会复用保存的参数。需要修改参数时，先停止对应服务，再带完整配置启动。例如：

```sh
codesesh hub stop
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
```

停止两项服务：

```sh
codesesh worker stop
codesesh hub stop
```

停止不会删除归档或 Worker 队列。如果停止命令报告超时，需要再次检查状态，不能直接认为进程已经退出。

## 升级可执行文件

npm 安装方式可以先停止服务，再更新并重新注册新命令路径：

```sh
codesesh worker stop
codesesh hub stop
npm install --global codesesh@latest
codesesh --version
codesesh hub start
codesesh worker start
```

原生安装方式则在停止后，通过安装脚本或发布制品替换可执行文件，再启动。多机环境先升级 Hub，再升级 Worker。仅执行 `restart` 不会注册新安装二进制的路径。

## 查找日志，了解后台运行边界

`status` 会打印实际使用的日志目录。默认位置为：

- `~/.codesesh/services/hub.log` 和 `worker.log`：后台进程的标准输出与错误，包括部分启动失败。
- `~/.codesesh/logs/codesesh-*.log`：各进程独立写入的结构化应用日志，会自动轮转。

服务日志内容很少，不代表应用日志没有开启。排查时同时检查这两处。不要分享 `services/*.json` 文件，其中可能包含凭据。把日志附到问题反馈前，检查其中的私人信息。

macOS 使用用户 launchd 任务，Linux 使用 systemd user unit，Windows 使用当前登录用户的任务计划程序。这些命令不会启用开机或登录自启动。macOS 和 Windows 依赖相应的已登录用户会话；Linux 需要可用的 systemd 用户环境。这套后台服务不保证注销后持续运行。
