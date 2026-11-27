---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: session-history
---

多くのローカル AI コーディングエージェントは、ホームディレクトリ配下の隠し JSONL フォルダや SQLite データベースに会話履歴を保存します。Claude Code は `~/.claude/projects/`（入力履歴は `~/.claude/history.jsonl`）、Codex は `~/.codex/sessions/` の `rollout-*.jsonl` に保存し、Cursor、OpenCode、Gemini CLI などもそれぞれ独自の保存先を持ちます。CodeSesh はこれらのローカル記録を 1 つの Web UI に集約し、データを外部へ送信せずに検索・再生できます。

ツール別の詳細な保存構成や再開コマンドは、[Claude Code](/ja/guides/claude-code-session-history/)、[Codex](/ja/guides/codex-session-history/)、[Cursor](/ja/guides/cursor-session-history/)、[OpenCode](/ja/guides/opencode-session-history/)、[Gemini CLI](/ja/guides/gemini-cli-session-history/) の各専用ガイドを参照してください。

## 主なエージェントの標準保存場所

`~` は現在のユーザーのホームディレクトリです。CodeSesh は標準で次の場所を読み込みます。

| Agent       | 標準の保存先                                                                                                               | 環境変数による上書き            | 標準の再開コマンド |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------ |
| Claude Code | `~/.claude/projects/`                                                                                                      | `CLAUDE_CONFIG_DIR`             | `claude --resume`  |
| Codex       | `~/.codex/sessions/`                                                                                                       | `CODEX_HOME`                    | `codex resume`     |
| Cursor      | `~/Library/Application Support/Cursor/User`（macOS）、`~/.config/Cursor/User`（Linux）、`%APPDATA%\Cursor\User`（Windows） | `CURSOR_DATA_PATH`              | —                  |
| OpenCode    | `~/.local/share/opencode/opencode.db`                                                                                      | `OPENCODE_DB` / `XDG_DATA_HOME` | `opencode -s`      |
| Gemini CLI  | `~/.gemini/tmp/`                                                                                                           | `GEMINI_CLI_HOME`               | `gemini --resume`  |
| Droid       | `~/.factory/sessions/`                                                                                                     | `FACTORY_HOME_OVERRIDE`         | `droid --resume`   |
| Pi          | `~/.pi/agent/sessions/`                                                                                                    | `PI_CODING_AGENT_DIR`           | `pi --session`     |
| Antigravity | `~/.gemini/antigravity/conversations/`                                                                                     | `ANTIGRAVITY_CONVERSATIONS_DIR` | —                  |

コーディングツールと同じ環境変数が有効なターミナルから CodeSesh を起動してください。`CLAUDE_CONFIG_DIR` や `CODEX_HOME` はツールのルートディレクトリを指し、`projects/` や `sessions/` を直接指すものではありません。

確認時によくある注意点は以下の 2 点です。

- **Codex のアーカイブ：** 現在の Codex アダプターは標準で `~/.codex/sessions/` を対象としており、`~/.codex/archived_sessions/` はスキャンしません。
- **Claude Code の入力履歴と会話本体：** `~/.claude/history.jsonl` は入力プロンプトの履歴のみを記録し、応答やツール出力、サブエージェントの記録は `~/.claude/projects/` 配下に置かれます。

## 標準 CLI 再開とプロジェクト横断検索の使い分け

同じリポジトリ内で直近のスレッドを再開するだけなら、`claude --resume` や `codex resume` が手軽です。一方、エラー文言や編集したファイルパスしか覚えていない場合や、数週間前に別ツールで行った作業を探す場合は、標準のリストだけでは見つけにくくなります。

既存の JSONL ファイルをテキストエディターで直接開くこともできますが、ツール実行イベントが多く含まれるため横断検索には向きません。確認する際は元のファイルを変更しないでください。

## CodeSesh で会話履歴を検索・再生する

CodeSesh は対応エージェントのローカル記録を SQLite に索引化し、プロジェクトやエージェントをまたいで本文、ツール出力、ファイルパスを検索できます。単体モードではアカウント不要で、履歴はすべて端末内に残ります。単体バイナリなどの導入方法は[インストールガイド](/ja/guides/getting-started/)を参照してください。

Node.js 22 以降を用意し、全期間を対象にして起動します。

```sh
npx codesesh --days 0
```

CodeSesh が `http://localhost:4521`（使用中の場合はターミナルに表示された空きポート）を開きます。閲覧中はターミナルプロセスを起動したままにしてください。

**なぜ `--days 0` を付けるのか？** 通常の `npx codesesh` は起動を速くするため、ローカル日付で直近 7 日間に活動があった会話だけを表示します。古い会話を探す場合は `--days 0` を指定します。

## プロジェクト・エージェント・ファイルから探す

数週間前に `my-app` リポジトリでログインのタイムアウトを修正したものの、Claude Code と Codex のどちらを使ったか覚えていない場合：

1. グローバル検索を開き、会話本文やエラー出力に出てきた特徴的な語句を入力します。
2. プロジェクトフィルター、Agent フィルター、スマートタグで結果を絞ります。
3. 表現を思い出せない場合は `src/auth.ts` のようなファイルパスを検索するか、ファイルアクティビティから該当ファイルを読み書きした会話を一覧表示します。
4. 一致した会話を開いてメッセージやツール呼び出しを時系列で確認し、作業を再開したければ再開コマンドをコピーします。

現在のプロジェクトだけに絞って起動する場合：

```sh
npx codesesh --days 0 --cwd .
```

Claude Code と Codex だけを対象にする場合：

```sh
npx codesesh --days 0 --agent claudecode,codex
```

再生は記録済みの会話とツール出力を読み返すだけで、コマンドの再実行やファイル変更は行いません。画面の概要は[製品デモ](/ja/#tour)、トークンや費用の確認方法は[使用量とコストガイド](/ja/guides/usage-and-costs/)で確認できます。

<span id="troubleshooting"></span>

## 会話が見つからない場合の確認手順

- **期間を確認する。** `--days 0` で再起動するか、画面の期間を「全期間」に切り替えます。`--from`、`--to`、`--cwd`、`--agent` の制限も外して確認してください。
- **保持期間とアーカイブを確認する。** Claude Code は `cleanupPeriodDays`（既定 30 日）を過ぎた古い履歴を自動削除します。Codex では `archived_sessions/` に移動されていないか確認します。
- **環境変数を確認する。** `CLAUDE_CONFIG_DIR` や `CODEX_HOME` などが CodeSesh を起動するシェルにも設定されているか確認してください。
- **インデックス完了を待つ。** 初回の取り込みと全文索引はバックグラウンドで進むため、一覧に出てすぐは古い本文がまだ検索対象にならないことがあります。
- **再現する解析問題を報告する。** 元ファイルが存在して読めるのに表示されない場合は、CodeSesh のバージョン、Agent 名、機密情報を除いたエラー内容を添えて [Issue を作成](https://github.com/xingkaixin/codesesh/issues)してください。

## ローカルインデックスの範囲

CodeSesh は読み取り専用のビューアーと検索インデックスであり、元ファイルのバックアップではありません。取り込み前に削除された履歴は復元できず、`--json` 出力もメッセージ全文ではなくセッションのメタデータです。

履歴を長期保存したい場合は、エージェントの元データディレクトリをバックアップしてください。対応ツール一覧は [CodeSesh の製品紹介](/ja/)で確認できます。
