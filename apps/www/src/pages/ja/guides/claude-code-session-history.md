---
layout: ../../../layouts/GuideLayout.astro
locale: ja
slug: claude-code-session-history
---

Claude Code は完全なローカルセッション記録を `~/.claude/projects/<プロジェクトパス>/<session-id>.jsonl` に保存し、入力プロンプトの履歴を `~/.claude/history.jsonl` に分けて記録します。ターミナルで以前の会話を再開するには `claude --continue` または `claude --resume` を使います。複数プロジェクトをまたいで本文、ツール出力、変更ファイルを検索したい場合は `npx codesesh --agent claudecode --days 0` を実行してください。

## Claude Code の履歴ファイルの保存場所

既定では `~/.claude/` 配下に保存されます（`~` はホームディレクトリ）。`CLAUDE_CONFIG_DIR` を設定している場合は、以下のパスがすべてそのディレクトリ配下になります。

- **セッション本体（`~/.claude/projects/<project>/<session-id>.jsonl`）：** 1 行 1 JSON でユーザー入力、応答、推論、ツール呼び出し、出力、トークン使用量を記録します。作業ディレクトリごとにパスをエンコードしたフォルダが作られます。
- **サブエージェント履歴（`<session>/subagents/*.jsonl`）：** サブエージェントやワークフロー実行時の JSONL と `.meta.json` は親セッション配下に保存されます。CodeSesh はこれらを親セッションの下に階層表示します。
- **プロンプト履歴（`~/.claude/history.jsonl`）：** 入力したプロンプトと時刻だけを記録します。応答本文やツール実行結果は含まれません。

過去の修正内容やエラー出力を確認したい場合は、`history.jsonl` ではなく `~/.claude/projects/` 配下の JSONL を参照してください。

## CLI から以前のセッションを一覧表示・再開する

元のプロジェクトディレクトリにいる場合は、Claude Code 本体のコマンドでそのまま再開できます。

現在のディレクトリで直近の会話を続ける：

```sh
claude --continue
```

過去のセッション一覧から対話的に選んで再開する：

```sh
claude --resume
```

セッション ID を指定して直接再開する：

```sh
claude --resume <session-id>
```

起動中の Claude Code セッション内では、`/resume` コマンドでも別の会話へ切り替えられます。

## 古い Claude Code セッションが見つからない原因

`claude --resume` や `~/.claude/projects/` に過去の会話が見当たらない場合は、次の 3 点を確認してください。

- **自動削除設定（`cleanupPeriodDays`）：** Claude Code は `~/.claude/settings.json` の `cleanupPeriodDays`（既定 30 日）を過ぎたローカル JSONL を自動削除します。削除された元ファイルは、バックアップまたは削除前の CodeSesh 索引がない限り復元できません。
- **異なる作業ディレクトリや git worktree：** セッションはプロジェクトパス単位で分かれるため、親ディレクトリや別 worktree から実行すると過去のセッションが一覧に出ません。
- **別の `CLAUDE_CONFIG_DIR`：** 別の設定ディレクトリで起動していた会話は `~/.claude/projects/` には保存されません。

## CodeSesh で Claude Code の履歴を横断検索・再生する

リポジトリをまたいでエラー出力や変更ファイルを起点に会話を探す場合、CodeSesh で `~/.claude/projects/` をローカル SQLite に索引化するとすばやく見つかります。

既定の直近 7 日間ではなく、すべてのローカル履歴を対象に起動する：

```sh
npx codesesh --agent claudecode --days 0
```

現在のリポジトリだけに絞る：

```sh
npx codesesh --agent claudecode --days 0 --cwd .
```

Web UI では次の操作ができます。

- **プロジェクト横断検索：** 会話本文、ツール出力、ファイルパスをまとめて検索し、一致箇所へ直接移動できます。
- **サブエージェントの階層表示：** 親セッションと子セッションをまとめて確認し、トークン数や推定コストを合算表示します。
- **ファイル起点の逆引き：** `src/auth.ts` などのパスから、読み取り・編集・作成を行った会話を一覧できます。
- **再開コマンドのコピー：** 詳細画面から作業ディレクトリに対応した `claude --resume <session-id>` をそのままコピーできます。

Codex も併用している場合は [Codex のセッション履歴ガイド](/ja/guides/codex-session-history/)や[ローカル会話履歴の探し方](/ja/guides/session-history/)、Node.js 不要の導入手順は[インストールガイド](/ja/guides/getting-started/)を参照してください。

## 元の履歴ファイルを安全に保つ

CodeSesh は読み取り専用であり、`~/.claude/projects/` のファイルを変更・削除しません。長期間保持したい場合は `~/.claude/settings.json` の `cleanupPeriodDays` を見直し、`~/.claude/projects/` をバックアップしてください。
