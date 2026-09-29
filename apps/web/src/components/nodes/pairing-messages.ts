import { t as translate } from "../../i18n/translate";

const messages = {
  Connection: ["连接方式", "接続方法"],
  "This machine": ["本机", "このマシン"],
  "Local network": ["局域网", "ローカルネットワーク"],
  "Public network": ["公网", "パブリックネットワーク"],
  "Hub address reachable from the Worker": [
    "Worker 可访问的 Hub 地址",
    "Worker から接続できる Hub アドレス",
  ],
  "Loopback addresses work only on the Hub machine.": [
    "回环地址仅适用于 Hub 所在机器。",
    "ループバックアドレスは Hub と同じマシンでのみ利用できます。",
  ],
  "Use a LAN IP or hostname. HTTP is unencrypted; use it only on a trusted network. Worker verifies the resolved addresses.":
    [
      "使用内网 IP 或域名。HTTP 未加密，请仅在可信局域网使用；Worker 会验证域名解析地址。",
      "LAN の IP またはホスト名を使ってください。HTTP は暗号化されません。信頼できるネットワークでのみ利用してください。Worker は名前解決後のアドレスを検証します。",
    ],
  "Public connections require HTTPS with a trusted certificate.": [
    "公网连接需要 HTTPS 和受信任的证书。",
    "パブリック接続には信頼できる証明書を使った HTTPS が必要です。",
  ],
  "Hub must listen on a LAN interface with --remote-access. Allow its port through the firewall.": [
    "Hub 需监听局域网接口并启用 --remote-access，同时允许该端口通过防火墙。",
    "Hub を LAN インターフェースで起動し、--remote-access を指定してください。ファイアウォールでポートを許可してください。",
  ],
  "Run mode": ["运行方式", "実行方法"],
  "Foreground \u2014 try the connection": ["前台运行：验证连接", "フォアグラウンド：接続を確認"],
  "Background service \u2014 keep collecting": [
    "后台服务：持续采集",
    "バックグラウンド：収集を継続",
  ],
  "Continues after closing the terminal. Manage it with codesesh worker status, stop, or restart. Autostart is not enabled.":
    [
      "关闭终端后继续运行。通过 codesesh worker status、stop 或 restart 管理，不启用自启动。",
      "ターミナルを閉じても実行を続けます。codesesh worker status、stop、restart で管理します。自動起動は有効になりません。",
    ],
  "Runs in this terminal. Press Ctrl+C to stop.": [
    "在当前终端运行，按 Ctrl+C 停止。",
    "このターミナルで実行します。Ctrl+C で停止します。",
  ],
  "Enter a valid Hub origin for the selected connection type.": [
    "请输入符合所选连接方式的 Hub 地址，不包含路径或凭据。",
    "選択した接続方法に合う Hub アドレスを入力してください。パスや認証情報は含めないでください。",
  ],
  "Worker paired successfully": ["Worker 配对成功", "Worker のペアリングに成功しました"],
  "Source node: {0}": ["来源节点：{0}", "ソースノード: {0}"],
  "Check collection and upload progress in Source nodes.": [
    "可在来源节点中查看采集和上传进度。",
    "ソースノードで収集とアップロードの進捗を確認できます。",
  ],
  "Pairing token expired. Generate a new token below.": [
    "配对码已过期，可在下方重新生成。",
    "トークンの期限が切れました。下から再発行してください。",
  ],
  "Generate new token": ["重新生成配对码", "トークンを再発行"],
  "Pairing status unavailable. Check the Worker terminal or retry.": [
    "配对状态暂不可用，请查看 Worker 终端或重试。",
    "ペアリング状態を確認できません。Worker のターミナルを確認するか再試行してください。",
  ],
  "Unable to create a new token. Try again.": [
    "无法生成新的配对码，请重试。",
    "新しいトークンを発行できません。再試行してください。",
  ],
} as const;

export function t(message: string, values: readonly (string | number)[] = []) {
  return translate(message, values, undefined, messages);
}
