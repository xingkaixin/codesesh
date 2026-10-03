---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: multi-machine-sync
---

CodeSesh 可以把多台电脑的 AI 编码历史汇总到一个 Hub。Hub 放在用于统一浏览和保存历史的电脑上，每台存有源会话的机器运行一个已配对的 Worker。Worker 上传到你自己的 Hub；Hub 不会自动采集所在电脑。

## 启动 Hub 并打开控制台

先在参与的机器上安装 CodeSesh。需要在可信局域网中连接 Hub 时，停止已有单机进程，再启动：

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
codesesh hub status
```

如果已有使用其他配置的 Hub，先停止再带这组参数启动。按[局域网访问指南](/zh/guides/lan-access/)打开带 token 的控制台链接并检查防火墙。公网连接应使用 HTTPS，证书需要被 Worker 信任。

## 配对第一台 Worker

在 Hub 的 Web 界面打开**来源节点**，创建一个配对令牌。然后在需要采集的机器上运行：

```sh
codesesh worker start --hub http://192.168.1.20:4521 --name laptop --pair-token-stdin
```

把示例 IP 换成你的 Hub 地址，按提示粘贴配对令牌。令牌十分钟内有效，只能使用一次。`--pair-token-stdin` 让令牌不出现在命令参数和 Shell 历史中。

浏览器访问 token 不能代替配对令牌。配对成功后，Worker 会保存自己的凭据，正常重启不必重新配对。

## 同时采集 Hub 所在电脑

在控制台再创建一个配对令牌，然后启动独立的本机 Worker：

```sh
codesesh worker start --hub http://127.0.0.1:4521 --name desktop --pair-token-stdin
```

其他机器分别重复配对步骤。每台机器使用自己的 Worker 状态和配对凭据。需要限制采集范围时，在首次配置中加入 `--agent claudecode,codex`。默认 Worker 采集已启用 Agent 可发现的全部历史，Hub 的时间范围控制浏览范围。

Worker 连接另一台 Hub，且发现旧单机数据库时，可能要求选择 `--history import` 或 `--history ignore`。前者导入旧归档，后者跳过旧归档，但仍采集可读取的源记录。明确选择后，在完整配对命令中加入对应参数再运行。同一数据目录的本机 Worker 配对自己的 Hub 时，可以复用原有本机历史，不需要这项选择。

## 检查同步进度

```sh
codesesh worker status
codesesh hub status
```

来源节点页显示最近联系、待上传批次数、字节数和采集错误。批次数是协议操作数，不是会话数。Worker 显示已连接时，仍可能正在上传积压；能浏览旧数据不代表新数据已经全部到达。

Hub 暂时离线时，Worker 会继续采集，并把待上传内容保存在自己的数据库中。恢复网络后，让它用已保存凭据重连。不要为了处理临时断网而删除 Worker 状态。遇到凭据或版本错误时，按状态提示处理，并优先升级 Hub，再升级 Worker。

## 按来源浏览历史

通过来源筛选查看单个节点或合并视图。项目分组不会让一个 Worker 获得冒充其他来源的权限。这是使用控制台 token 访问的历史查看器，不是带独立账号权限的多用户工作区。

重启、修改配置和查找日志，参阅[后台服务指南](/zh/guides/background-services/)。
