---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: gemini-cli-session-history
---

Gemini CLI はローカルの会話記録を `~/.gemini/tmp/<project-hash>/chats/` 配下に JSON / JSONL ファイルとして保存します。`GEMINI_CLI_HOME` を設定している場合は `$GEMINI_CLI_HOME/.gemini/tmp/` が使われます。ターミナルで再開するには `gemini --resume`、プロジェクト横断で会話・ツール出力・トークン消費量を検索するには `npx codesesh --agent gemini-cli --days 0` を実行してください。

## Gemini CLI の会話履歴の保存先

既定ではホームディレクトリ配下にプロジェクトごとのハッシュフォルダが作られます。

- **セッションファイル：** `~/.gemini/tmp/<project-hash>/chats/*.json` および `*.jsonl`
- **環境変数による上書き：** `GEMINI_CLI_HOME` で `.gemini/` の親ディレクトリを指定（CodeSesh は `$GEMINI_CLI_HOME/.gemini/tmp/` をスキャンします）

ディレクトリ名がリポジトリ名ではなくハッシュ値になっているため、ファイルシステム上から過去の会話を手作業で探すのは手間がかかります。

## ターミナルで過去の Gemini CLI セッションを再開する

対象プロジェクトのディレクトリ内で標準の再開コマンドを実行します。

```sh
gemini --resume
```

CodeSesh などから取得したセッション ID がある場合は `gemini --resume <session-id>` で直接再開できます。

## CodeSesh で Gemini CLI の履歴を検索・再生する

CodeSesh は `~/.gemini/tmp/*/chats/` を読み取り専用でスキャンし、プロジェクト単位でローカル SQLite に索引化します。

ローカルの Gemini CLI 履歴を全期間スキャンする：

```sh
npx codesesh --agent gemini-cli --days 0
```

現在のリポジトリだけに絞って表示する：

```sh
npx codesesh --agent gemini-cli --days 0 --cwd .
```

`http://localhost:4521` の Web UI では次のことができます。

- **ハッシュフォルダを意識せず横断検索：** プロンプト、応答、ツール出力、変更ファイルパスを一括検索できます。
- **推論とツール呼び出しの時系列再生：** 思考ステップ、ツール実行結果、サブエージェントのネスト構造を順番に追えます。
- **トークン消費量と推定コストの確認：** プロジェクトやモデルごとにトークン数と推定費用を把握できます。
- **再開コマンドのコピー：** 詳細画面から `gemini --resume <session-id>` をそのままコピーできます。

## Gemini CLI の会話が見つからない場合

- **`GEMINI_CLI_HOME` の指定を確認する。** `.gemini/tmp/` ではなく、`.gemini/` を含む親ディレクトリを指す必要があります。
- **`--days 0` を指定する。** 既定では直近 7 日間のみを表示するため、古い履歴は `--days 0` または画面の「全期間」で確認してください。
- **`tmp` ディレクトリの削除に注意。** `~/.gemini/tmp/` を手動削除すると元データが失われます。スキャン前に削除されたファイルは復元できません。

関連ガイド：[ローカル会話履歴の全体ガイド](/ja/guides/session-history/)、[Claude Code 会話履歴ガイド](/ja/guides/claude-code-session-history/)、[Codex セッション履歴ガイド](/ja/guides/codex-session-history/)。
