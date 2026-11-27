---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: opencode-session-history
---

OpenCode はローカルのセッション履歴を SQLite データベース `~/.local/share/opencode/opencode.db`（`XDG_DATA_HOME` 設定時は `$XDG_DATA_HOME/opencode/opencode.db`）に保存し、`OPENCODE_DB` で場所を上書きできます。ターミナルで再開するには `opencode -s <session-id>`、リポジトリ横断で検索・再生・コスト確認をするには `npx codesesh --agent opencode --days 0` を実行します。

## OpenCode データベースの保存場所

既定では、セッション、メッセージ、ツール呼び出し、推論ステップ、記録済みコストが 1 つの SQLite ファイルに保存されます。

- **既定のパス：** `~/.local/share/opencode/opencode.db`
- **XDG による上書き：** `XDG_DATA_HOME` 設定時は `$XDG_DATA_HOME/opencode/opencode.db`
- **直接指定：** `OPENCODE_DB`（絶対パスまたはデータディレクトリ基準のファイル名。`:memory:` はスキップされます）

CodeSesh は OpenCode の V1（`session`）と V2（`session_v2` / `session_message`）の両方のスキーマおよび V1→V2 移行中のデータベースに対応しています。

## ターミナルから OpenCode セッションを再開する

セッション ID がわかっている場合は、`opencode -s` でそのまま再開できます。

```sh
opencode -s <session-id>
```

CodeSesh のセッション詳細画面からは、作業ディレクトリ付きの `opencode -s <session-id>` コマンドをワンクリックでコピーできます。

## CodeSesh で OpenCode の履歴を検索・再生する

SQLite データベース内のログは通常のファイル検索で見つけにくいですが、CodeSesh は `opencode.db` を読み取り専用で開き、プロジェクト別に整理されたローカル Web UI に索引化します。

すべての OpenCode 履歴をスキャンする：

```sh
npx codesesh --agent opencode --days 0
```

現在のリポジトリだけに絞る：

```sh
npx codesesh --agent opencode --days 0 --cwd .
```

`http://localhost:4521` では次の操作が可能です。

- **本文・ツール出力の横断検索：** プロンプト、応答、シェル出力、変更ファイルをプロジェクト横断で検索できます。
- **サブエージェントの階層表示：** 親セッション配下に子セッションをまとめ、トークンやコストを階層ごとに集計します。
- **記録済みコストと推論の確認：** OpenCode が記録した費用とトークン数を、推論ステップやツール呼び出しとあわせて確認できます。
- **再開コマンドのコピー：** 目的の履歴を見つけたら `opencode -s <session-id>` で即座に再開できます。

## OpenCode のセッションが見つからない場合

- **`OPENCODE_DB` と `XDG_DATA_HOME` をそろえる。** OpenCode を起動したときと同じ環境変数を持つシェルから CodeSesh を起動してください。
- **`--days 0` を付ける。** 既定では直近 7 日間のみ表示されるため、古い履歴を見るには `--days 0` または画面の「全期間」を選びます。
- **`:memory:` モードを確認する。** `OPENCODE_DB=:memory:` の場合はディスクに保存されないため索引化できません。

関連ガイド：[Claude Code 会話履歴ガイド](/ja/guides/claude-code-session-history/)、[Codex セッション履歴ガイド](/ja/guides/codex-session-history/)、[トークン消費量とコストガイド](/ja/guides/usage-and-costs/)。
