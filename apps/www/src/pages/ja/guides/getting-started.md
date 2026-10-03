---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: getting-started
---

CodeSesh は Claude Code や Codex など、対応ツールの履歴をローカルの Web 画面で閲覧するためのツールです。コマンド一つで試す方法と、単体の実行ファイルをインストールする方法があります。端末に会話の記録が必要です。CodeSesh 自体が会話を作成するわけではありません。

## インストール方法を選ぶ

Node.js 22 以降があれば、グローバルインストールなしで試せます。

```sh
npx codesesh
```

macOS、Linux、Windows で日常的に使う場合は、コマンドをインストールします。

```sh
npm install --global codesesh
codesesh --version
codesesh
```

Node.js を使わない場合、macOS と Linux ではネイティブインストーラーを利用できます。

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | sh
```

OS と CPU に対応した実行ファイルがダウンロードされます。Windows でも [GitHub Releases](https://github.com/xingkaixin/codesesh/releases) から対応するアーカイブを取得できます。単体の実行ファイルには Node.js は不要です。

## ローカル画面を開く

起動すると URL が表示され、通常はブラウザーも開きます。既定のアドレスは `http://127.0.0.1:4521/` です。別のポートが選ばれた場合は、表示された URL を使ってください。閲覧中はターミナルを開いたままにします。前面のサーバーを停止するには Ctrl+C を押します。

既定では同じ端末からだけアクセスできます。ローカルでもトークン認証を使うには `codesesh --auth` で起動し、表示されたリンクを開きます。別の端末から開く場合は [LAN 接続ガイド](/ja/guides/lan-access/)を参照してください。

## 閲覧する期間を選ぶ

既定では、直近七日間のローカル暦日内に活動があった会話を表示します。古い会話を探すには全期間を指定します。

```sh
codesesh --days 0
```

プロジェクトのディレクトリで実行すると、プロジェクトと Agent を絞れます。

```sh
codesesh --cwd . --agent claudecode,codex --days 0
```

固定した期間はローカルの日付で指定します。

```sh
codesesh --from 2026-09-01 --to 2026-09-30
```

`--from` を指定すると既定の日数指定より優先されます。大量の履歴がある場合、初回のインデックス作成には時間がかかります。保存場所や検索方法は[会話履歴ガイド](/ja/guides/session-history/)で確認できます。

## 単体モードと Hub モードを選ぶ

`codesesh` は一つのプロセスで本機を収集し、Web 画面を提供します。Hub は保存済みデータの閲覧を担当し、Worker が収集と送信を行います。複数端末には [Hub と Worker](/ja/guides/multi-machine-sync/)、ターミナルを閉じた後も動かす場合は[バックグラウンド実行](/ja/guides/background-services/)を使います。

同じデータディレクトリでモードを切り替える前に、単体モードのプロセスを停止してください。同じディレクトリで両モードを同時に動かすことはできません。
