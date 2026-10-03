---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: background-services
---

`codesesh hub start` と `codesesh worker start` は現在のユーザーのバックグラウンドタスクを登録します。起動後はターミナルを閉じられます。Web 画面は Hub、収集はペアリング済み Worker が担当します。`start` のない `codesesh hub` は前面で動きます。

## ペアリング済みの構成を用意する

初回は[複数端末のガイド](/ja/guides/multi-machine-sync/)で設定します。Hub だけでは保存済み履歴の閲覧のみで、本機の収集は行いません。同じデータディレクトリを使う単体モードは先に停止します。

本機からだけ閲覧する Hub は次のように起動します。

```sh
codesesh hub start
codesesh hub status
codesesh hub open
```

LAN 接続には初回から [LAN ガイド](/ja/guides/lan-access/)の全引数を使います。ペアリング済みの Worker は新しいトークンなしで起動できます。

```sh
codesesh worker start
codesesh worker status
```

前面でペアリングした Worker も、保存済みの接続先と認証情報を使えます。バックグラウンド設定がまだない場合、収集設定には今回の引数と既定値が使われます。対象を絞る場合は `--agent` を明示してください。

## 起動完了を確認する

`start` は約十秒まで待ちます。初期化が長い場合はバックグラウンドで続きます。状態を追跡するには次を使います。

```sh
codesesh hub status --watch
codesesh worker status --watch
```

Ctrl+C は状態の監視を終了するだけで、サービスは止めません。Hub の準備ができたら `codesesh hub open` で開けます。Worker は接続済みでも未送信データが残る場合があります。

## 再起動と設定変更

通常の再起動は次のとおりです。

```sh
codesesh hub restart
codesesh worker restart
```

保存済みの引数が再利用されます。設定を変えるには該当サービスを停止し、必要な引数をすべて指定して起動します。

```sh
codesesh hub stop
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
```

両方を停止するには次を実行します。

```sh
codesesh worker stop
codesesh hub stop
```

停止してもアーカイブや送信待ちキューは削除されません。停止がタイムアウトした場合は、終了したと判断せず状態を再確認してください。

## 実行ファイルを更新する

npm でインストールした場合は、停止、更新、新しい実行パスの登録を順に行います。

```sh
codesesh worker stop
codesesh hub stop
npm install --global codesesh@latest
codesesh --version
codesesh hub start
codesesh worker start
```

ネイティブ版は停止後、インストーラーかリリースのアーカイブで実行ファイルを置き換えてから起動します。複数端末では Hub を先に更新します。`restart` だけでは、新しくインストールした実行ファイルのパスは登録されません。

## ログと実行範囲を確認する

`status` は実際のログ保存先を表示します。既定の場所は次のとおりです。

- `~/.codesesh/services/hub.log` と `worker.log`：標準出力と標準エラー。起動時の問題などを記録します。
- `~/.codesesh/logs/codesesh-*.log`：プロセスごとの構造化ログ。自動ローテーションされます。

サービスログが短くても、アプリケーションログは別に出力されます。両方を確認してください。`services/*.json` には認証情報が含まれることがあるため共有しないでください。ログも個人情報を確認してから添付します。

macOS はユーザーの launchd、Linux は systemd user unit、Windows はログイン中のユーザーのタスクスケジューラを使います。これらのコマンドは起動時やログイン時の自動実行を有効にしません。macOS と Windows は該当ユーザーのログインセッション、Linux は利用可能な systemd ユーザー環境が必要です。ログアウト後の継続実行は保証されません。
