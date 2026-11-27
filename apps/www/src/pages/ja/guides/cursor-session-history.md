---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: cursor-session-history
---

Cursor は Composer やチャットの会話履歴を、ユーザーデータディレクトリ配下の SQLite データベース `globalStorage/state.vscdb` に保存します（macOS は `~/Library/Application Support/Cursor/User`、Linux は `~/.config/Cursor/User`、Windows は `%APPDATA%\Cursor\User`）。SQLite を手動で開かずにプロジェクト横断で検索・再生するには、`npx codesesh --agent cursor --days 0` を実行してください。

## Cursor のチャット履歴の保存場所

既定では OS 標準のアプリケーションデータディレクトリに保存されます。`CURSOR_DATA_PATH` に `Cursor/User` ディレクトリを設定している場合、CodeSesh はそちらを読み込みます。

- **macOS：** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Linux：** `~/.config/Cursor/User/globalStorage/state.vscdb`（または `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`）
- **Windows：** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`

`state.vscdb` 内部では、`cursorDiskKV` テーブルの `composerData:*`、`bubbleId:*`、`bubble:*` キーに JSON 形式で会話が格納されています。プレーンテキストではないため、`grep` などで直接検索することはできません。

## CodeSesh で Cursor の履歴を検索・再生する

Cursor のエディター上では別ワークスペースの古い履歴やツール出力を横断検索しにくくなります。CodeSesh は `state.vscdb` を読み取り専用で読み込み、Composer の会話とツール実行結果をローカルの検索インデックスにまとめます。

ローカルのすべての Cursor 履歴をスキャンする：

```sh
npx codesesh --agent cursor --days 0
```

現在のリポジトリだけに絞って表示する：

```sh
npx codesesh --agent cursor --days 0 --cwd .
```

`http://localhost:4521` の Web UI では次のことができます。

- **ワークスペース横断検索：** すべてのプロジェクトを対象に、プロンプト、応答、ツール出力、ファイルパスを一括検索できます。
- **時系列での再生：** 古い Cursor ウィンドウを開き直さずに、やり取りやツール結果を順番に確認できます。
- **CLI エージェントとの統合閲覧：** `--agent cursor` を外すと、Claude Code、Codex、OpenCode、Gemini CLI の履歴と同じプロジェクトツリーで並べて見られます。

Cursor はデスクトップ IDE のため CLI 再開コマンドは提供されていません。CodeSesh では閲覧・検索専用として表示します。

## Cursor の会話が見つからないときの確認手順

- **`--days 0` を指定する。** 既定の `npx codesesh` は直近 7 日間のみを表示します。古い履歴を探す場合は `--days 0` または画面の「全期間」を選んでください。
- **`CURSOR_DATA_PATH` を確認する。** カスタムプロファイルを使っている場合は、`globalStorage/state.vscdb` を含む `User` ディレクトリを指すように設定してください。
- **トークンとコストの扱い。** Cursor の記録は一部セッションでトークン数が部分的な場合があります。モデル名とトークン数が取得できたセッションはローカルで推定コストを計算します。

他のツールの詳細は [Claude Code 会話履歴ガイド](/ja/guides/claude-code-session-history/)、[Codex セッション履歴ガイド](/ja/guides/codex-session-history/)、または[ローカル会話履歴の全体ガイド](/ja/guides/session-history/)を参照してください。

## 元データを安全に保つ・書き出しとの使い分け

CodeSesh は常に読み取り専用で `state.vscdb` にアクセスし、Cursor のデータベースを変更しません。再インストール前などにバックアップを取りたい場合は、Cursor を終了してから `state.vscdb` ファイルを直接コピーしてください。CodeSesh はローカル検索・再生・コスト分析に特化しており、Cursor の会話を独立したファイルとして書き出したい場合は [Agent Dump](https://agent-dump.xingkaixin.me/) と併用できます。
