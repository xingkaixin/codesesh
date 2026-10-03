---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: lan-access
---

CodeSesh Hub を本機と同じ LAN の別端末から開くには、`0.0.0.0` で待ち受け、`--remote-access` を有効にします。別端末では Hub の LAN IP を使い、表示されたコンソール URL のトークンを残してください。既定の `127.0.0.1` は Hub 本機からの接続だけを受け付けます。

## 固定ポートで Hub を起動する

[インストールガイド](/ja/guides/getting-started/)で `codesesh` コマンドを用意します。単体モードを使っている場合は Ctrl+C で停止します。バックグラウンドの Hub が起動済みなら、設定変更の前に停止します。

```sh
codesesh hub stop
```

新しい設定で起動します。

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
codesesh hub status
```

`0.0.0.0` はループバックと LAN を含むすべての IPv4 インターフェイスで待ち受けます。ブラウザーでは具体的な IP を使います。Hub は本機を自動収集しません。会話がない場合は[複数端末のガイド](/ja/guides/multi-machine-sync/)に従って Worker を追加してください。

## 本機と別端末で画面を開く

`hub status` の `Console` URL 全体をコピーします。URL には `access_token` が含まれます。ホスト部分だけを変更します。

- Hub 本機では `127.0.0.1` を使います。
- 別端末では Hub の LAN IP、例えば `192.168.1.20` を使います。

IP は Hub のネットワーク設定で確認できます。別端末で `127.0.0.1` を使うと、その端末自身を指してしまいます。ポートとトークンは変更しないでください。

リモートアクセスを有効にすると、ループバックからでもトークンが必要です。Hub プロセスを再起動するとトークンが変わるため、新しいリンクを取得します。画面用のトークンは Worker のペアリングトークンとは別物です。

## 接続できない場合の確認

1. Hub 本機で開けることと、`codesesh hub status` が ready であることを確認します。
2. LAN IP とポートを確認します。DHCP で IP が変わると以前のリンクは使えません。
3. Hub のファイアウォールで TCP 4521 の受信を許可します。ゲスト Wi-Fi や端末間の分離設定も確認します。
4. ページは開くのに認証エラーになる場合は、現在の `Console` リンクを取得し直します。

以後、設定引数なしの `codesesh hub start` は保存済み設定を使います。アドレスやポートを変更する場合は停止してから全引数を指定して起動します。`restart` は既存設定を再利用します。

## HTTP と HTTPS を選ぶ

上の設定は暗号化されない HTTP なので、信頼できる LAN で使います。通信の暗号化が必要なら、証明書と秘密鍵を指定できます。

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521 \
  --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

設定を置き換える前に既存の Hub を停止します。証明書は接続先のアドレスに有効で、クライアントに信頼されている必要があります。HTTPS リバースプロキシを使う場合はバックエンドをループバックに置きます。[リモートアクセス設定](https://github.com/xingkaixin/codesesh/blob/main/README.md)を参照してください。トークンは認証に使われますが、HTTP 通信を暗号化しません。
