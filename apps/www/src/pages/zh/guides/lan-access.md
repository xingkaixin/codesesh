---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: lan-access
---

要让 CodeSesh Hub 同时支持本机和局域网访问，将监听地址设为 `0.0.0.0`，并开启 `--remote-access`。另一台设备使用 Hub 所在电脑的内网 IP，访问时保留控制台链接中的 token。默认的 `127.0.0.1` 只接受来自 Hub 本机的连接。

## 使用固定端口启动 Hub

先按[安装指南](/zh/guides/getting-started/)安装 `codesesh` 命令。如果正在运行单机模式，用 Ctrl+C 停止。如果已有后台 Hub，改配置前先停止：

```sh
codesesh hub stop
```

然后用新配置启动：

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
codesesh hub status
```

`0.0.0.0` 监听全部 IPv4 网络接口，包括本机回环和局域网接口。它是监听地址，浏览器应使用具体 IP。Hub 不会自动采集本机；如果界面没有会话，按[多机同步指南](/zh/guides/multi-machine-sync/)添加 Worker。

## 在本机和其他设备上打开界面

复制 `hub status` 输出的完整 `Console` 链接，其中包含 `access_token`。只替换链接里的主机地址：

- 在 Hub 本机，使用 `127.0.0.1`。
- 在另一台设备，使用 Hub 电脑的局域网 IP，例如 `192.168.1.20`。

可以在 Hub 电脑的网络设置中查找 IP。不要在另一台设备上使用 `127.0.0.1`，因为它指向那台设备自己。保留原链接的端口和 token。

开启远程访问后，即使通过本机回环地址访问，也需要 token。每次 Hub 进程重启都会生成新 token，应重新获取链接。浏览器访问 token 与 Worker 的配对令牌用途不同。

## 无法连接时依次检查

1. 先在 Hub 本机打开控制台，确认 `codesesh hub status` 显示就绪。
2. 检查另一台设备使用的内网 IP 和端口。路由器重新分配 IP 后，旧链接可能失效。
3. 在 Hub 电脑的防火墙中允许 TCP 4521 入站连接。访客 Wi-Fi 或客户端隔离也可能阻止设备互访。
4. 页面能打开但接口提示需要 token 时，重新获取当前的 `Console` 链接。

后续不带配置参数的 `codesesh hub start` 会复用已保存设置。再次修改地址或端口时，先停止服务，再带完整参数启动。`restart` 只复用已有配置。

## 何时使用 HTTPS

上面的命令使用未加密的 HTTP，适用于可信局域网。需要传输加密时，可以提供证书和私钥，由 CodeSesh 处理 TLS：

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521 \
  --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

使用这组替换配置前，先停止已有 Hub。客户端必须信任证书，证书也必须覆盖实际使用的访问地址。使用 HTTPS 反向代理时，后端须继续绑定回环地址，具体见[远程访问配置](https://github.com/xingkaixin/codesesh/blob/main/README.md)。访问 token 用于验证请求身份，不会加密 HTTP 流量。
