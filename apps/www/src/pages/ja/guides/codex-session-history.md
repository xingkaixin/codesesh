---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: codex-session-history
---

Codex はアクティブなローカルセッションを `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` として日付別に保存し、タイトル索引を `~/.codex/session_index.jsonl`、アーカイブ済みスレッドを `~/.codex/archived_sessions/` に置きます。CLI から過去のセッションを再開するには `codex resume` または `codex resume --last` を使います。複数リポジトリをまたいでローカル検索・再生したい場合は `npx codesesh --agent codex --days 0` を実行してください。

## Codex のセッション保存フォルダ構成

既定では `~/.codex/` 配下に保存されます（`~` はホームディレクトリ）。`CODEX_HOME` を設定している場合は、Codex と CodeSesh の両方がそのディレクトリを参照します。

- **アクティブな記録（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）：** プロンプト、応答、推論ステップ、実行コマンド、パッチ、トークン使用量を含む JSONL ファイルです。
- **タイトル索引（`~/.codex/session_index.jsonl`）：** スレッド ID と表示名（`thread_name`）の対応表です。CodeSesh もこれを読み込み、タイトルを一覧や検索結果に反映します。
- **アーカイブ（`~/.codex/archived_sessions/`）：** Codex 上でアーカイブしたスレッドが移動されます。現在の CodeSesh の Codex アダプターは既定で `sessions/` のみをスキャンし、`archived_sessions/` は対象外です。

JSONL ファイルをエディターで直接開くときは、元のファイルを編集せずに確認してください。

## ターミナルから Codex セッションを一覧・再開する

最近のセッションに戻るだけなら、Codex 標準のコマンドが最も手軽です。

対話式ピッカーから履歴を選んで再開する：

```sh
codex resume
```

直前のセッションをそのまま再開する：

```sh
codex resume --last
```

セッション ID を指定して再開する：

```sh
codex resume <session-id>
```

## CodeSesh で Codex の履歴を検索・再生する

Codex の `rollout-*.jsonl` はリポジトリ別ではなく日付別に保存されるため、数週間前の作業を複数のプロジェクトから探すには手間がかかります。CodeSesh はローカルの Codex セッションビューアーとして rollout ファイルを解析し、リポジトリ単位での整理、サブエージェントの階層化、本文・コマンド出力・ファイルパスの SQLite 全文索引を自動で行います。

すべてのローカル Codex 履歴を対象に起動する：

```sh
npx codesesh --agent codex --days 0
```

現在のリポジトリだけに絞る：

```sh
npx codesesh --agent codex --days 0 --cwd .
```

`http://localhost:4521` の Web UI では次のことができます。

- **リポジトリ横断検索：** 日付フォルダを探さずに、会話本文、シェル出力、ファイルパスから目的のスレッドを見つけられます。
- **コマンドと差分の時系列再生：** 実行したコマンド、変更差分、推論の流れを順番に読み返せます。
- **トークンとコストの確認：** セッション・プロジェクト・モデル単位で使用量と推定コストを確認できます（詳細は[使用量とコストガイド](/ja/guides/usage-and-costs/)）。
- **再開コマンドのコピー：** 詳細画面から作業ディレクトリに合った `codex resume <session-id>` をワンクリックでコピーできます。

## Codex のセッションが見つからない場合

- **`archived_sessions/` を確認する：** Codex でアーカイブした会話は `sessions/` から `archived_sessions/` に移動するため、既定の CodeSesh スキャンには含まれません。
- **`--days 0` を付ける：** 通常の `npx codesesh` は直近 7 日間のみ表示します。古い履歴を見るには `--days 0` を指定するか、画面で「全期間」を選びます。
- **`CODEX_HOME` を揃える：** Codex 実行時と同じ `CODEX_HOME` 環境変数が CodeSesh 起動シェルにも設定されているか確認してください。
- **初回インデックス完了を待つ：** 履歴が多い場合、初回取り込みはバックグラウンドで進みます。完了後に全文検索が可能になります。

Claude Code などの他ツールも使っている場合は [Claude Code の会話履歴ガイド](/ja/guides/claude-code-session-history/)および[ローカル会話履歴の探し方](/ja/guides/session-history/)、Node.js 不要の導入手順は[インストールガイド](/ja/guides/getting-started/)を参照してください。
