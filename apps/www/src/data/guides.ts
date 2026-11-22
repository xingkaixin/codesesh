import { localeConfig, locales, siteUrl, type FAQItem, type Locale } from "./landing";

interface GuideLocaleCopy {
  title: string;
  description: string;
  faq?: FAQItem[];
}

interface Guide {
  slug: string;
  category: "start" | "connect" | "understand";
  published: string;
  updated: string;
  copy: Record<Locale, GuideLocaleCopy>;
}

export const guides: Guide[] = [
  {
    slug: "getting-started",
    category: "start",
    published: "2026-10-03",
    updated: "2026-10-03",
    copy: {
      en: {
        title: "Install CodeSesh and browse AI coding sessions",
        description:
          "Install CodeSesh on macOS, Linux, or Windows. Choose npm or a standalone binary, open local Claude Code and Codex history, and select a time range.",
      },
      zh: {
        title: "安装 CodeSesh，浏览本地 AI 编码会话",
        description:
          "在 macOS、Linux 或 Windows 上安装 CodeSesh。选择 npm 或独立可执行文件，查看 Claude Code、Codex 历史，并设置时间和项目范围。",
      },
      ja: {
        title: "CodeSesh をインストールして AI コーディング履歴を見る",
        description:
          "macOS、Linux、Windows で CodeSesh を起動する手順。npm と単体バイナリの選び方、Claude Code や Codex の履歴、期間とプロジェクトの指定を説明します。",
      },
    },
  },
  {
    slug: "session-history",
    category: "start",
    published: "2026-10-03",
    updated: "2026-11-22",
    copy: {
      en: {
        title: "How to find AI coding session history locally",
        description:
          "Where Claude Code, Codex, Cursor, OpenCode, and Gemini CLI store local history, how native resume commands compare, and how to search across projects with CodeSesh.",
        faq: [
          {
            question: "Where do Claude Code and Codex store local session history?",
            answer:
              "Claude Code stores full JSONL transcripts under ~/.claude/projects/ and prompt history in ~/.claude/history.jsonl. Codex stores active rollout-*.jsonl transcripts under ~/.codex/sessions/ and archived threads under ~/.codex/archived_sessions/.",
          },
          {
            question: "Why does npx codesesh only show recent conversations at first?",
            answer:
              "By default, CodeSesh opens with sessions active in the last 7 local calendar days while older history scans in the background. Run npx codesesh --days 0 or switch the time range in the UI to view all indexed history.",
          },
          {
            question: "Can CodeSesh recover deleted AI coding sessions?",
            answer:
              "No. CodeSesh is a read-only viewer and local search index. It keeps already-indexed records if a source disappears temporarily, but it cannot recover transcripts deleted before they were scanned.",
          },
        ],
      },
      zh: {
        title: "如何查找本地 AI 编码历史会话",
        description:
          "汇总 Claude Code、Codex、Cursor、OpenCode、Gemini CLI 等工具的本地历史路径与原生恢复命令，以及如何用 CodeSesh 跨项目搜索和回放对话。",
        faq: [
          {
            question: "Claude Code 和 Codex 的本地会话记录存在哪里？",
            answer:
              "Claude Code 将完整 JSONL 会话保存在 ~/.claude/projects/，输入历史在 ~/.claude/history.jsonl。Codex 将活跃会话 rollout-*.jsonl 保存在 ~/.codex/sessions/，归档会话在 ~/.codex/archived_sessions/。",
          },
          {
            question: "为什么默认运行 npx codesesh 只看到最近几天的对话？",
            answer:
              "默认命令只展示最近 7 个本地日历日内活跃的会话，更早的历史会在后台继续扫描。运行 npx codesesh --days 0 或在界面切换时间范围为「全部」，即可查看所有历史。",
          },
          {
            question: "CodeSesh 能恢复已经被删掉的会话记录吗？",
            answer:
              "不能。CodeSesh 是只读查看器和本地搜索索引，不会修改原始文件，也无法恢复在扫描前已被 Agent 删除的本地历史记录。",
          },
        ],
      },
      ja: {
        title: "ローカルの AI コーディング会話履歴を探す方法",
        description:
          "Claude Code、Codex、Cursor、OpenCode、Gemini CLI のローカル履歴の保存場所と再開コマンドを整理し、CodeSesh でプロジェクト横断検索する手順を説明します。",
        faq: [
          {
            question: "Claude Code と Codex の会話履歴はどこに保存されますか？",
            answer:
              "Claude Code は完全な JSONL 記録を ~/.claude/projects/、入力履歴を ~/.claude/history.jsonl に保存します。Codex はアクティブな rollout-*.jsonl を ~/.codex/sessions/、アーカイブを ~/.codex/archived_sessions/ に保存します。",
          },
          {
            question: "npx codesesh で最近の会話しか表示されないのはなぜですか？",
            answer:
              "既定ではローカル日付で直近 7 日間に活動があった会話だけを表示し、古い履歴はバックグラウンドで取り込みます。npx codesesh --days 0 で起動するか、画面の期間を「全期間」に切り替えてください。",
          },
          {
            question: "削除された AI コーディング履歴を CodeSesh で復元できますか？",
            answer:
              "できません。CodeSesh は読み取り専用のビューアーと検索インデックスです。スキャン前に元の保存先から削除されたファイルは復元できません。",
          },
        ],
      },
    },
  },
  {
    slug: "claude-code-session-history",
    category: "start",
    published: "2026-11-22",
    updated: "2026-11-22",
    copy: {
      en: {
        title: "Claude Code session history: storage & resume",
        description:
          "Find where Claude Code stores JSONL transcripts and history.jsonl, reopen previous sessions with claude --resume, check why old sessions disappear, and search across projects with CodeSesh.",
        faq: [
          {
            question: "Where is Claude Code history stored on disk?",
            answer:
              "Claude Code stores full session transcripts as JSONL files under ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl, with subagent runs in nested subagents/ directories. Prompt input history is stored separately in ~/.claude/history.jsonl. If CLAUDE_CONFIG_DIR is set, Claude Code uses that directory instead of ~/.claude.",
          },
          {
            question: "How do I open a previous session in Claude Code?",
            answer:
              "Run claude --continue (or claude -c) in the same project directory to reopen the latest conversation, or run claude --resume to pick from past sessions interactively. If you know the session ID, run claude --resume <session-id>, or use /resume inside an active Claude Code session.",
          },
          {
            question: "What is the difference between history.jsonl and projects/*.jsonl?",
            answer:
              "~/.claude/history.jsonl only records your prompt inputs and metadata for terminal history recall. The full conversation—assistant replies, tool calls, tool output, reasoning, and token usage—lives in ~/.claude/projects/<project>/<session-id>.jsonl.",
          },
          {
            question: "Why are my old or archived Claude Code sessions missing?",
            answer:
              "Claude Code automatically deletes local session transcripts after its configured cleanupPeriodDays retention window (30 days by default in ~/.claude/settings.json). Sessions can also appear missing if you ran Claude Code from a different directory or with a different CLAUDE_CONFIG_DIR.",
          },
        ],
      },
      zh: {
        title: "Claude Code 历史会话指南：存储位置、恢复与搜索",
        description:
          "查看 Claude Code 的 JSONL 会话文件和 history.jsonl 保存位置，用 claude --resume 打开旧对话，排查老会话消失原因，并用 CodeSesh 跨项目搜索回放。",
        faq: [
          {
            question: "Claude Code 的历史对话保存在本地哪里？",
            answer:
              "完整会话以 JSONL 文件保存在 ~/.claude/projects/<项目路径编码>/<session-id>.jsonl，子 Agent 记录在对应会话的 subagents/ 子目录下；终端输入历史则单独记录在 ~/.claude/history.jsonl。如果设置了 CLAUDE_CONFIG_DIR，根目录会替换为该路径。",
          },
          {
            question: "如何在 Claude Code 中打开之前的会话？",
            answer:
              "在原项目目录运行 claude --continue（或 claude -c）可直接继续最近一次对话；运行 claude --resume 会打开交互式列表选择历史会话；已知会话 ID 时可运行 claude --resume <session-id>，也可以在对话内输入 /resume 切换。",
          },
          {
            question: "history.jsonl 和 projects/*.jsonl 有什么区别？",
            answer:
              "~/.claude/history.jsonl 只保存用户输入过的提示词和基础索引，方便命令行回溯；完整的助手回复、工具调用、命令输出、思考过程和 Token 用量都保存在 ~/.claude/projects/ 下的会话 JSONL 文件中。",
          },
          {
            question: "为什么较早的 Claude Code 会话不见了？",
            answer:
              "Claude Code 会按 ~/.claude/settings.json 中的 cleanupPeriodDays 自动清理旧的本地会话文件（默认 30 天）。此外，切换了工作目录或使用了不同的 CLAUDE_CONFIG_DIR 也会导致原生 --resume 列表看不到旧记录。",
          },
        ],
      },
      ja: {
        title: "Claude Code の会話履歴：保存場所・再開・検索ガイド",
        description:
          "Claude Code の JSONL ログと history.jsonl の保存先、claude --resume での再開方法、古い履歴が消える原因、CodeSesh でのプロジェクト横断検索を解説します。",
        faq: [
          {
            question: "Claude Code の会話履歴はどこに保存されていますか？",
            answer:
              "完全なセッション記録は ~/.claude/projects/<プロジェクトパス>/<session-id>.jsonl に保存され、サブエージェントの記録はその配下の subagents/ に置かれます。プロンプト入力履歴は ~/.claude/history.jsonl に分かれています。CLAUDE_CONFIG_DIR が設定されている場合はそのディレクトリが使われます。",
          },
          {
            question: "Claude Code で以前のセッションを開くにはどうすればよいですか？",
            answer:
              "同じプロジェクトディレクトリで claude --continue（または claude -c）を実行すると直近の会話を再開できます。一覧から選ぶ場合は claude --resume、セッション ID がわかっている場合は claude --resume <session-id>、セッション中なら /resume を使います。",
          },
          {
            question: "history.jsonl と projects/*.jsonl の違いは何ですか？",
            answer:
              "~/.claude/history.jsonl は入力プロンプトの履歴のみを記録します。応答本文、ツール呼び出し、実行結果、推論ステップ、トークン使用量を含む完全な記録は ~/.claude/projects/ 配下の JSONL ファイルに保存されます。",
          },
          {
            question: "古い Claude Code セッションが見つからないのはなぜですか？",
            answer:
              "Claude Code は ~/.claude/settings.json の cleanupPeriodDays（既定では 30 日）を過ぎたローカル履歴を自動削除します。また、別の作業ディレクトリや異なる CLAUDE_CONFIG_DIR で起動していた場合も一覧に表示されません。",
          },
        ],
      },
    },
  },
  {
    slug: "codex-session-history",
    category: "start",
    published: "2026-11-22",
    updated: "2026-11-22",
    copy: {
      en: {
        title: "Codex session history: folder, resume & viewer",
        description:
          "Locate ~/.codex/sessions/ rollout JSONL files and archived_sessions, list and reopen threads with codex resume, and browse Codex history locally with CodeSesh.",
        faq: [
          {
            question: "Where does Codex store session history files?",
            answer:
              "Codex saves active session transcripts as rollout-*.jsonl inside date-nested directories under ~/.codex/sessions/YYYY/MM/DD/, keeps thread titles in ~/.codex/session_index.jsonl, and moves archived threads to ~/.codex/archived_sessions/. Setting CODEX_HOME changes ~/.codex to that root.",
          },
          {
            question: "How do I list or resume a previous Codex session from the CLI?",
            answer:
              "Run codex resume to open the interactive session picker, codex resume --last to jump back into your most recent session, or codex resume <session-id> when you already have the thread ID.",
          },
          {
            question: "Does CodeSesh read ~/.codex/archived_sessions/?",
            answer:
              "No. The current CodeSesh Codex adapter scans ~/.codex/sessions/ (or $CODEX_HOME/sessions/) by default and does not scan ~/.codex/archived_sessions/. If a session was archived in Codex, it stays in archived_sessions/ as a readable JSONL file.",
          },
          {
            question: "How do I search Codex history across multiple repositories?",
            answer:
              "Run npx codesesh --agent codex --days 0. CodeSesh indexes every local Codex rollout-*.jsonl file into SQLite so you can search prompts, assistant replies, shell output, and touched file paths across all repositories and copy worktree-aware codex resume commands.",
          },
        ],
      },
      zh: {
        title: "Codex 历史会话指南：目录结构、恢复命令与本地查看器",
        description:
          "定位 ~/.codex/sessions/ 下的 rollout JSONL 与 archived_sessions，掌握 codex resume 列出和恢复会话的方法，并用 CodeSesh 跨仓库搜索和回放 Codex 历史。",
        faq: [
          {
            question: "Codex 的会话历史文件保存在哪个目录？",
            answer:
              "活跃会话以 rollout-*.jsonl 格式按日期存放在 ~/.codex/sessions/YYYY/MM/DD/，会话标题索引位于 ~/.codex/session_index.jsonl，归档会话位于 ~/.codex/archived_sessions/。如果设置了 CODEX_HOME，则以该目录替代 ~/.codex。",
          },
          {
            question: "如何在命令行列出或恢复之前的 Codex 会话？",
            answer:
              "运行 codex resume 可打开交互式列表选择历史会话，运行 codex resume --last 直接回到最近一次会话，已知 ID 时可运行 codex resume <session-id>。",
          },
          {
            question: "CodeSesh 会扫描 ~/.codex/archived_sessions/ 吗？",
            answer:
              "目前默认不会。CodeSesh 的 Codex 适配器扫描 ~/.codex/sessions/（或 $CODEX_HOME/sessions/）。在 Codex 中归档后的会话仍以标准 JSONL 文件保留在 archived_sessions/ 中，可直接查阅。",
          },
          {
            question: "怎么跨项目全文搜索 Codex 历史对话？",
            answer:
              "运行 npx codesesh --agent codex --days 0。CodeSesh 会把本地所有 rollout-*.jsonl 建立 SQLite 索引，支持按关键词、命令输出和文件路径跨仓库检索，并可一键复制带目录上下文的 codex resume 命令。",
          },
        ],
      },
      ja: {
        title: "Codex のセッション履歴：保存先・再開コマンド・ビューアー",
        description:
          "~/.codex/sessions/ の rollout JSONL や archived_sessions の構成、codex resume での一覧・再開手順、CodeSesh によるローカル検索と再生を解説します。",
        faq: [
          {
            question: "Codex のセッション履歴はどこに保存されますか？",
            answer:
              "アクティブな履歴は ~/.codex/sessions/YYYY/MM/DD/ 配下に rollout-*.jsonl として保存され、タイトル索引は ~/.codex/session_index.jsonl、アーカイブ済みは ~/.codex/archived_sessions/ に置かれます。CODEX_HOME を設定している場合はそのルートが使われます。",
          },
          {
            question: "CLI から過去の Codex セッションを一覧表示・再開するには？",
            answer:
              "codex resume で対話式ピッカーを開き、codex resume --last で直前のセッションに戻れます。セッション ID がある場合は codex resume <session-id> を直接実行します。",
          },
          {
            question: "CodeSesh は ~/.codex/archived_sessions/ もスキャンしますか？",
            answer:
              "既定ではスキャンしません。現在の Codex アダプターは ~/.codex/sessions/（または $CODEX_HOME/sessions/）を対象にしています。アーカイブ済みの記録は archived_sessions/ に JSONL として残っています。",
          },
          {
            question: "複数リポジトリをまたいで Codex の履歴を検索するには？",
            answer:
              "npx codesesh --agent codex --days 0 を実行してください。ローカルの rollout-*.jsonl を SQLite に索引化し、プロンプト本文、コマンド出力、ファイルパスを横断検索でき、codex resume コマンドもそのままコピーできます。",
          },
        ],
      },
    },
  },
  {
    slug: "lan-access",
    category: "connect",
    published: "2026-10-03",
    updated: "2026-10-03",
    copy: {
      en: {
        title: "Access CodeSesh from another device on your LAN",
        description:
          "Open the CodeSesh Hub from localhost and another computer on your LAN. Configure the listening address, access token, fixed port, and firewall checks.",
      },
      zh: {
        title: "让 CodeSesh 同时支持本机和局域网访问",
        description:
          "配置 CodeSesh Hub 的监听地址、访问令牌和固定端口，让本机与局域网内的其他电脑都能打开 Web 界面，并排查连接失败。",
      },
      ja: {
        title: "CodeSesh を同じ LAN の別端末から開く",
        description:
          "CodeSesh Hub の待受アドレス、アクセストークン、固定ポートを設定し、同じ LAN の端末から Web 画面を開く手順と接続の確認方法を説明します。",
      },
    },
  },
  {
    slug: "multi-machine-sync",
    category: "connect",
    published: "2026-10-03",
    updated: "2026-10-03",
    copy: {
      en: {
        title: "Collect AI coding history from multiple computers",
        description:
          "Use a CodeSesh Hub and paired Workers to browse AI coding sessions from several computers. Connect a local Worker, pair a remote node, and check sync status.",
      },
      zh: {
        title: "用 Hub 和 Worker 汇总多台电脑的 AI 编码历史",
        description:
          "用 CodeSesh Hub 统一浏览多台电脑的会话。了解 Hub 与 Worker 的分工，配对本机和远程节点，并检查同步状态与积压。",
      },
      ja: {
        title: "複数のパソコンの AI コーディング履歴をまとめる",
        description:
          "CodeSesh Hub と Worker で複数端末の会話を一か所に集約します。役割の違い、ローカルとリモートのペアリング、同期状況の確認を説明します。",
      },
    },
  },
  {
    slug: "background-services",
    category: "connect",
    published: "2026-10-03",
    updated: "2026-10-03",
    copy: {
      en: {
        title: "Run CodeSesh Hub and Worker in the background",
        description:
          "Keep CodeSesh running after closing the terminal. Start, stop, inspect, and upgrade Hub and Worker background services, and locate startup and application logs.",
      },
      zh: {
        title: "让 CodeSesh Hub 和 Worker 在后台运行",
        description:
          "关闭终端后继续运行 CodeSesh。学习 Hub 和 Worker 后台服务的启动、停止、状态检查、配置更新、版本升级与日志排查。",
      },
      ja: {
        title: "CodeSesh Hub と Worker をバックグラウンドで動かす",
        description:
          "ターミナルを閉じても CodeSesh を実行する方法。Hub と Worker の起動、停止、状態確認、設定変更、アップグレード、ログの場所を説明します。",
      },
    },
  },
  {
    slug: "usage-and-costs",
    category: "understand",
    published: "2026-10-03",
    updated: "2026-10-03",
    copy: {
      en: {
        title: "Understand AI token usage and costs in CodeSesh",
        description:
          "Review AI coding token usage by project, model, and date in CodeSesh. Understand recorded versus estimated cost, cache tokens, and differences from provider bills.",
      },
      zh: {
        title: "查看 AI 编码的 Token 用量和成本",
        description:
          "用 CodeSesh 按项目、模型和时间查看 AI 编码用量，区分记录成本与估算成本，理解缓存 Token，以及统计与服务商账单的差异。",
      },
      ja: {
        title: "CodeSesh で AI のトークン使用量とコストを確認する",
        description:
          "プロジェクト、モデル、期間ごとに AI コーディングの使用量を確認します。記録された費用と推定額、キャッシュトークン、請求書との差を説明します。",
      },
    },
  },
];

export const guideCopy = {
  en: {
    title: "CodeSesh usage guides",
    label: "Guides",
    description:
      "Practical guides to browsing local AI coding history, connecting your computers, and understanding usage with CodeSesh.",
    home: "Home",
    updated: "Updated",
    contents: "On this page",
    faq: "Frequently asked questions",
    related: "Related guides",
    all: "Browse all guides",
    start: "Start locally",
    connect: "Connect your devices",
    understand: "Understand usage",
    by: "By CodeSesh",
    terminal: "Terminal",
    copyFailed: "Copy failed",
    count: "{count} guides",
    countOne: "{count} guide",
    startHere: "Start here",
    startBody: "One command starts CodeSesh and finds supported agent history on this computer.",
    startComment: "Opens the web UI at http://localhost:4521",
    readStart: "Read the getting started guide",
    categories: "Guide categories",
    breadcrumb: "Breadcrumb",
    read: "Read",
  },
  zh: {
    title: "CodeSesh 使用指南",
    label: "使用指南",
    description:
      "从浏览本地 AI 编码历史，到连接多台电脑、理解用量，按实际使用场景了解 CodeSesh 的配置与操作。",
    home: "首页",
    updated: "更新于",
    contents: "本文目录",
    faq: "常见问题",
    related: "相关指南",
    all: "查看全部指南",
    start: "开始在本机使用",
    connect: "连接你的设备",
    understand: "理解用量",
    by: "作者：CodeSesh",
    terminal: "终端",
    copyFailed: "复制失败",
    count: "{count} 篇指南",
    countOne: "{count} 篇指南",
    startHere: "从这里开始",
    startBody: "一条命令启动，自动发现本机受支持的 Agent 历史。",
    startComment: "在 http://localhost:4521 打开 Web UI",
    readStart: "阅读入门指南",
    categories: "指南分类",
    breadcrumb: "面包屑",
    read: "阅读",
  },
  ja: {
    title: "CodeSesh の使い方",
    label: "使い方",
    description:
      "ローカルの AI コーディング履歴の閲覧、複数端末の接続、使用量の確認まで。目的に合わせた CodeSesh の設定と操作を紹介します。",
    home: "ホーム",
    updated: "更新日",
    contents: "目次",
    faq: "よくある質問",
    related: "関連ガイド",
    all: "すべてのガイド",
    start: "ローカルで使う",
    connect: "端末を接続する",
    understand: "使用量を知る",
    by: "著者：CodeSesh",
    terminal: "ターミナル",
    copyFailed: "コピー失敗",
    count: "{count} 件のガイド",
    countOne: "{count} 件のガイド",
    startHere: "ここから始める",
    startBody: "コマンド一つで起動し、この端末にある対応エージェントの履歴を自動で見つけます。",
    startComment: "http://localhost:4521 で Web UI を開きます",
    readStart: "入門ガイドを読む",
    categories: "ガイドの分類",
    breadcrumb: "パンくずリスト",
    read: "読む",
  },
} satisfies Record<Locale, Record<string, string>>;

export const guideCategories = [
  { key: "start", icon: "terminal" },
  { key: "connect", icon: "network" },
  { key: "understand", icon: "bar-chart-3" },
] as const;

export function guideCount(locale: Locale, count: number) {
  const t = guideCopy[locale];
  return (count === 1 ? t.countOne : t.count).replace("{count}", String(count));
}

export function guideRoutes(slug = ""): Record<Locale, string> {
  return {
    en: `/guides/${slug ? `${slug}/` : ""}`,
    zh: `/zh/guides/${slug ? `${slug}/` : ""}`,
    ja: `/ja/guides/${slug ? `${slug}/` : ""}`,
  };
}

export function guidePageConfig(locale: Locale, guide?: Guide) {
  const t = guideCopy[locale];
  const content = guide?.copy[locale];
  const title = content?.title ?? t.title;
  const description = content?.description ?? t.description;
  const faqItems = content?.faq ?? [];
  const routes = guideRoutes(guide?.slug);
  const url = new URL(routes[locale], siteUrl).toString();
  const indexUrl = new URL(guideRoutes()[locale], siteUrl).toString();
  const breadcrumbs = [
    { name: t.home, item: new URL(localeConfig[locale].route, siteUrl).toString() },
    { name: t.label, item: indexUrl },
    ...(guide ? [{ name: title, item: url }] : []),
  ];
  const mainEntity = guide
    ? faqItems.length > 0
      ? [{ "@id": `${url}#article` }, { "@id": `${url}#faq` }]
      : { "@id": `${url}#article` }
    : { "@id": `${url}#guides` };

  return {
    title: guide ? `${title} | CodeSesh` : t.title,
    description,
    route: routes[locale],
    alternateRoutes: routes,
    ogType: guide ? "article" : "website",
    schema: [
      {
        "@type": guide ? "WebPage" : "CollectionPage",
        "@id": `${url}#webpage`,
        url,
        name: title,
        description,
        inLanguage: localeConfig[locale].language,
        isPartOf: { "@id": `${siteUrl}/#website` },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        primaryImageOfPage: { "@id": `${siteUrl}/#primaryimage` },
        mainEntity,
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: breadcrumbs.map((entry, i) => ({
          "@type": "ListItem",
          position: i + 1,
          ...entry,
        })),
      },
      ...(guide
        ? [
            {
              "@type": "Article",
              "@id": `${url}#article`,
              headline: title,
              description,
              image: { "@id": `${siteUrl}/#primaryimage` },
              inLanguage: localeConfig[locale].language,
              datePublished: guide.published,
              dateModified: guide.updated,
              author: { "@id": `${siteUrl}/#author` },
              publisher: { "@id": `${siteUrl}/#organization` },
              mainEntityOfPage: { "@id": `${url}#webpage` },
              url,
            },
            ...(faqItems.length > 0
              ? [
                  {
                    "@type": "FAQPage",
                    "@id": `${url}#faq`,
                    isPartOf: { "@id": `${url}#webpage` },
                    mainEntity: faqItems.map((item) => ({
                      "@type": "Question",
                      name: item.question,
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: item.answer,
                      },
                    })),
                  },
                ]
              : []),
          ]
        : [
            {
              "@type": "ItemList",
              "@id": `${url}#guides`,
              itemListElement: guides.map((entry, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: entry.copy[locale].title,
                url: new URL(guideRoutes(entry.slug)[locale], siteUrl).toString(),
              })),
            },
          ]),
    ],
  };
}

const latestGuideUpdated = guides.reduce(
  (latest, guide) => (guide.updated > latest ? guide.updated : latest),
  "2026-10-03",
);

export const guideSitemapEntries = [undefined, ...guides].flatMap((guide) =>
  locales.map((locale) => ({
    route: guideRoutes(guide?.slug)[locale],
    alternates: Object.fromEntries(
      locales.map((key) => [localeConfig[key].language, guideRoutes(guide?.slug)[key]]),
    ),
    priority: "0.8",
    lastmod: guide?.updated ?? latestGuideUpdated,
  })),
);
