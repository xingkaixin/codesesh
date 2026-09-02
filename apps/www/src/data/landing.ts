import { AGENT_CATALOG } from "@codesesh/core/contract";

export const locales = ["en", "zh", "ja"] as const;

export type Locale = (typeof locales)[number];

export type HeadingCopy = string | string[];

export type IconName =
  | "bar-chart-3"
  | "bookmark"
  | "database"
  | "eye"
  | "keyboard"
  | "list-tree"
  | "search"
  | "settings"
  | "shield"
  | "tags"
  | "terminal"
  | "timer";

export interface ProductScene {
  title: string;
  description: string;
  hint: string;
}

export interface FeatureItem {
  icon: IconName;
  title: string;
  description: string;
}

export interface FeatureGroup {
  title: string;
  description: string;
  items: FeatureItem[];
}

export interface FAQItem {
  question: string;
  answer: string;
}

interface LandingCopy {
  meta: {
    title: string;
    description: string;
  };
  header: {
    tour: string;
    capabilities: string;
    agents: string;
    changelog: string;
    faq: string;
    github: string;
    languageLabel: string;
    themeLabel: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    themeSwitchTo: string;
  };
  hero: {
    eyebrow: string;
    title: HeadingCopy;
    body: string;
    privacy: string;
    command: string;
    endpoint: string;
    agentsLabel: string;
    copied: string;
    copyFailed: string;
    copyCommand: string;
  };
  tour: {
    previewLabel: string;
    sampleLabel: string;
    search: string;
    range: string;
    overview: string;
    projects: string;
    replay: string;
    filters: string;
    visibleStatus: string;
    userMessages: string;
    agentResponses: string;
    toolCalls: string;
    sampleProjects: string;
    sampleSessions: string;
  };
  scenes: ProductScene[];
  features: {
    title: HeadingCopy;
    body: string;
    groups: FeatureGroup[];
  };
  agents: {
    title: HeadingCopy;
    body: string;
  };
  faq: {
    title: HeadingCopy;
    body: string;
    items: FAQItem[];
  };
  cta: {
    title: HeadingCopy;
    body: string;
    github: string;
  };
  footer: {
    note: string;
    changelog: string;
    docs: string;
    issues: string;
  };
}

export const siteUrl = "https://codesesh.xingkaixin.me";

interface LocaleConfig {
  route: string;
  language: string;
  ogLocale: string;
  switchLabel: string;
  primaryNavigationLabel: string;
  siteControlsLabel: string;
  footerNavigationLabel: string;
}

export const localeConfig = {
  en: {
    route: "/",
    language: "en",
    ogLocale: "en_US",
    switchLabel: "EN",
    primaryNavigationLabel: "Primary navigation",
    siteControlsLabel: "Site controls",
    footerNavigationLabel: "Footer navigation",
  },
  zh: {
    route: "/zh/",
    language: "zh-CN",
    ogLocale: "zh_CN",
    switchLabel: "中文",
    primaryNavigationLabel: "主导航",
    siteControlsLabel: "站点控制",
    footerNavigationLabel: "页脚导航",
  },
  ja: {
    route: "/ja/",
    language: "ja",
    ogLocale: "ja_JP",
    switchLabel: "日本語",
    primaryNavigationLabel: "メインナビゲーション",
    siteControlsLabel: "サイト設定",
    footerNavigationLabel: "フッターナビゲーション",
  },
} satisfies Record<Locale, LocaleConfig>;

const agentDisplayNames = AGENT_CATALOG.map(({ displayName }) => displayName);
const agentCount = agentDisplayNames.length;
const agentNamesEn = `${agentDisplayNames.slice(0, -1).join(", ")}, and ${agentDisplayNames.at(-1)}`;
const agentNamesZh = `${agentDisplayNames.slice(0, -1).join("、")}和${agentDisplayNames.at(-1)}`;
const agentNamesJa = agentDisplayNames.join("、");

export const agents = AGENT_CATALOG.map((entry) => ({
  name: entry.displayName,
  icon: entry.icon,
  ...("iconColored" in entry ? { iconColored: entry.iconColored } : {}),
}));

export const copy = {
  zh: {
    meta: {
      title: "CodeSesh：搜索与回放本地 AI 编码历史",
      description: `CodeSesh 把 ${agentCount} 种 AI 编码 Agent 的本地会话按项目组织，提供结构化搜索、完整回放与本地 SQLite 索引，让工程上下文可查、可追溯。`,
    },
    header: {
      tour: "产品导览",
      capabilities: "能力",
      agents: "支持的 Agent",
      changelog: "更新日志",
      faq: "FAQ",
      github: "GitHub",
      languageLabel: "语言",
      themeLabel: "主题",
      themeLight: "浅色",
      themeDark: "深色",
      themeSystem: "跟随系统",
      themeSwitchTo: "，点击切换到{next}",
    },
    hero: {
      eyebrow: `本地运行 / 零配置 / ${agentCount} 个 Agent`,
      title: ["你和 AI 写过的", "每一次对话，都还在。"],
      body: `CodeSesh 把 ${agentCount} 种 Agent 的本地会话按项目归档，随时搜索、回放，数据始终留在本机。`,
      privacy: "会话内容与索引留在本机，无需账号、云同步或会话遥测。",
      command: "npx codesesh",
      endpoint: "http://localhost:4521",
      agentsLabel: "读取会话",
      copied: "已复制",
      copyFailed: "复制失败，请手动复制命令",
      copyCommand: "复制",
    },
    tour: {
      previewLabel: "CodeSesh 交互式产品示例",
      sampleLabel: "示例数据",
      search: "搜索示例会话",
      range: "示例数据时间范围",
      overview: "概览示例界面",
      projects: "项目树示例界面",
      replay: "会话回放示例界面",
      filters: "切换消息类型的显示与隐藏",
      visibleStatus: "当前显示 {count} 条消息",
      userMessages: "用户消息",
      agentResponses: "Agent 回复",
      toolCalls: "工具调用",
      sampleProjects: "示例项目",
      sampleSessions: "{label}：{count} 个示例会话",
    },
    scenes: [
      {
        title: "打开就知道这周花在哪儿了",
        description:
          "会话、消息、Token、成本与最近活跃都来自同一个本地索引。切换时间窗口，概览同步重算。",
        hint: "切换时间范围，观察整块面板同步重算",
      },
      {
        title: "会话回到它该在的项目里",
        description:
          "按仓库和项目身份归组，子 Agent 会话保留在父会话下，消息、Token 与成本按层级汇总。",
        hint: "展开带有 sub 标记的会话，查看子 Agent 记录",
      },
      {
        title: "一次任务的完整路径逐条还原",
        description:
          "消息、工具调用和文件变更按发生顺序呈现，类型过滤与文件追踪帮助你快速定位关键上下文。",
        hint: "展开工具调用查看输出，也可以从 TOC 隐藏消息类型",
      },
    ],
    features: {
      title: ["发现、组织、找回、复盘。", "四步之后，历史才真正能用。"],
      body: "CodeSesh 围绕真实的 AI 编码协作循环组织能力。",
      groups: [
        {
          title: "发现",
          description: "把不同 Agent 留下的本地会话统一纳入索引。",
          items: [
            {
              icon: "settings",
              title: "零配置启动",
              description: "运行一条命令，自动扫描文件系统里的受支持 Agent 会话。",
            },
            {
              icon: "eye",
              title: "统一时间线",
              description: `${agentCount} 种 Agent 的历史会话进入同一个界面。`,
            },
            {
              icon: "timer",
              title: "实时刷新",
              description: "本地会话变更自动进入索引，界面无需重启。",
            },
          ],
        },
        {
          title: "组织",
          description: "让会话回到项目、任务和工程语境里。",
          items: [
            {
              icon: "list-tree",
              title: "项目与嵌套会话树",
              description: "按仓库归组，并将子 Agent 会话保留在父会话下。",
            },
            {
              icon: "tags",
              title: "智能标签",
              description: "自动识别修复、重构、功能、测试、文档与规划等工作。",
            },
            {
              icon: "bookmark",
              title: "会话别名",
              description: "给重要会话一个易记名称，并在搜索与收藏中沿用。",
            },
          ],
        },
        {
          title: "找回",
          description: "把过去的判断、路径和上下文带回当前任务。",
          items: [
            {
              icon: "search",
              title: "结构化全局搜索",
              description: "搜索标题、消息、工具输出和文件路径，再按项目、标签与工具筛选。",
            },
            {
              icon: "list-tree",
              title: "文件活动索引",
              description: "从一个文件反查读取或修改过它的相关会话。",
            },
            {
              icon: "keyboard",
              title: "键盘导航",
              description: "切换视图、聚焦搜索和移动分组，全程不离键盘。",
            },
          ],
        },
        {
          title: "复盘",
          description: "还原一次任务从问题到结果的完整过程。",
          items: [
            {
              icon: "terminal",
              title: "完整会话回放",
              description: "消息、工具调用和推理步骤按发生顺序保留。",
            },
            {
              icon: "bar-chart-3",
              title: "成本与 Token 可见",
              description: "并列查看 Token、缓存命中、记录成本与按模型估算。",
            },
            {
              icon: "database",
              title: "本地 SQLite 索引",
              description: "一个本地数据库支撑快速恢复、检索与 schema 迁移。",
            },
          ],
        },
      ],
    },
    agents: {
      title: ["覆盖本地", "AI 编码工具链"],
      body: "每种 Agent 通过 core 适配器接入同一个会话、项目、搜索和文件活动索引。",
    },
    faq: {
      title: "常见问题",
      body: "关于 CodeSesh 的定位、安装方式、数据边界和大型历史。",
      items: [
        {
          question: "CodeSesh 是什么？",
          answer: `CodeSesh 是一个本地开发者工具，用来发现、聚合、搜索和回放 AI 编码会话历史。它把 ${agentNamesZh} 的本地记录整理成按项目组织的工程记忆层。`,
        },
        {
          question: "CodeSesh 会上传本地 AI 会话数据吗？",
          answer:
            "不会上传会话数据。CodeSesh 在本机使用 SQLite 索引，并通过 localhost 上的 Web UI 浏览历史。会话内容、文件路径、Token 统计和成本记录留在本机；产品不要求账号、云同步或会话遥测。",
        },
        {
          question: "如何安装和启动 CodeSesh？",
          answer:
            "在终端运行 npx codesesh。CodeSesh 会扫描受支持的本地 AI 编码会话，并在 http://localhost:4521 打开 Web UI；如果默认端口被占用，它会尝试下一个可用端口。发布版需要 Node.js 22 或更高版本。",
        },
        {
          question: "历史会话很多时，CodeSesh 如何保持流畅？",
          answer:
            "首次扫描会持久化回填进度，中断后可以继续。后续启动从本地 SQLite 缓存恢复，文件监听只增量更新发生变化的会话；长会话的消息列表按视口虚拟化，避免一次渲染全部内容。",
        },
      ],
    },
    cta: {
      title: "现在就把历史找回来",
      body: "开源、免费，会话数据留在本机。一条命令即可开始建立可搜索的 AI 编码工程记忆。",
      github: "GitHub",
    },
    footer: {
      note: "MIT 许可，会话数据与索引保留在本机",
      changelog: "更新日志",
      docs: "文档",
      issues: "问题反馈",
    },
  },
  en: {
    meta: {
      title: "CodeSesh: Search and Replay Local AI Coding History",
      description: `CodeSesh organizes local sessions from ${agentCount} AI coding agents by project, with structured search, full replay, and a local SQLite index.`,
    },
    header: {
      tour: "Tour",
      capabilities: "Capabilities",
      agents: "Agents",
      changelog: "Changelog",
      faq: "FAQ",
      github: "GitHub",
      languageLabel: "Language",
      themeLabel: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
      themeSystem: "System",
      themeSwitchTo: ". Switch to {next}.",
    },
    hero: {
      eyebrow: `Local / Zero config / ${agentCount} agents`,
      title: ["Every AI session.", "Still here."],
      body: `Search and replay local sessions from ${agentCount} AI coding agents, organized by project and kept on your machine.`,
      privacy:
        "Session content and indexes stay local. No account, cloud sync, or session telemetry.",
      command: "npx codesesh",
      endpoint: "http://localhost:4521",
      agentsLabel: "Reads sessions from",
      copied: "Copied",
      copyFailed: "Copy failed. Copy the command manually.",
      copyCommand: "Copy",
    },
    tour: {
      previewLabel: "Interactive CodeSesh product sample",
      sampleLabel: "Sample data",
      search: "Search sample sessions",
      range: "Sample data time range",
      overview: "Overview demo interface",
      projects: "Project tree demo interface",
      replay: "Session replay demo interface",
      filters: "Toggle message types on or off",
      visibleStatus: "Showing {count} messages",
      userMessages: "User",
      agentResponses: "Agent responses",
      toolCalls: "Tools",
      sampleProjects: "Sample projects",
      sampleSessions: "{label}: {count} sample sessions",
    },
    scenes: [
      {
        title: "Open it and see where the week went",
        description:
          "Sessions, messages, tokens, cost, and recent activity come from one local index. Change the time window and the overview recomputes.",
        hint: "Switch the time range and watch the whole panel recompute",
      },
      {
        title: "Sessions go back where they belong",
        description:
          "Group history by repository and project, keep subagent sessions under their parent, and aggregate messages, tokens, and cost by hierarchy.",
        hint: "Expand a session marked sub to inspect its child agent work",
      },
      {
        title: "Replay the complete path of a task",
        description:
          "Read messages, tool calls, and file changes in sequence, then use type filters and file tracking to find the context that matters.",
        hint: "Expand tool calls for output, or use the TOC to hide message types",
      },
    ],
    features: {
      title: ["Discover, organize, recover, replay.", "History becomes useful after all four."],
      body: "CodeSesh follows the real loop of AI-assisted engineering work.",
      groups: [
        {
          title: "Discover",
          description: "Bring local sessions from different agents into one index.",
          items: [
            {
              icon: "settings",
              title: "Zero configuration",
              description: "Run one command and scan supported agent sessions on your filesystem.",
            },
            {
              icon: "eye",
              title: "Unified timeline",
              description: `Browse histories from ${agentCount} AI coding agents in one interface.`,
            },
            {
              icon: "timer",
              title: "Live refresh",
              description: "Add local session changes to the index without restarting the UI.",
            },
          ],
        },
        {
          title: "Organize",
          description: "Put sessions back into project, task, and engineering context.",
          items: [
            {
              icon: "list-tree",
              title: "Project and session tree",
              description: "Group by repository and keep subagent sessions under their parent.",
            },
            {
              icon: "tags",
              title: "Smart tags",
              description: "Label fixes, refactors, features, tests, docs, planning, and more.",
            },
            {
              icon: "bookmark",
              title: "Session aliases",
              description:
                "Give key sessions memorable names that persist in search and bookmarks.",
            },
          ],
        },
        {
          title: "Recover",
          description: "Bring old decisions, paths, and context back into the current task.",
          items: [
            {
              icon: "search",
              title: "Structured global search",
              description:
                "Search titles, messages, tool output, and paths, then filter the results.",
            },
            {
              icon: "list-tree",
              title: "File activity index",
              description: "Start with a file and find sessions that read or changed it.",
            },
            {
              icon: "keyboard",
              title: "Keyboard navigation",
              description: "Switch views, focus search, and move through groups from the keyboard.",
            },
          ],
        },
        {
          title: "Replay",
          description: "Reconstruct the full path from problem to result.",
          items: [
            {
              icon: "terminal",
              title: "Full conversation replay",
              description: "Keep messages, tool calls, and reasoning steps in sequence.",
            },
            {
              icon: "bar-chart-3",
              title: "Cost and token visibility",
              description: "Compare tokens, cache hits, recorded cost, and model estimates.",
            },
            {
              icon: "database",
              title: "Local SQLite index",
              description:
                "Use one local database for fast restore, search, and schema migrations.",
            },
          ],
        },
      ],
    },
    agents: {
      title: "Built for the local AI coding stack",
      body: "Each agent connects through a core adapter and contributes to one index of sessions, projects, search, and file activity.",
    },
    faq: {
      title: "Frequently asked questions",
      body: "Answers about CodeSesh, installation, data boundaries, and large histories.",
      items: [
        {
          question: "What is CodeSesh?",
          answer: `CodeSesh is a local developer tool for discovering, aggregating, searching, and replaying AI coding session history. It turns local records from ${agentNamesEn} into a project-aware engineering memory layer.`,
        },
        {
          question: "Does CodeSesh upload local AI session data?",
          answer:
            "No session data is uploaded. CodeSesh uses a local SQLite index and a Web UI served on localhost. Session content, file paths, token statistics, and recorded costs remain on the computer. The product requires no account, cloud sync, or session telemetry.",
        },
        {
          question: "How do I install and start CodeSesh?",
          answer:
            "Run npx codesesh in a terminal. CodeSesh scans supported local AI coding sessions and opens its Web UI at http://localhost:4521. If the default port is busy, it tries the next available port. The published CLI requires Node.js 22 or later.",
        },
        {
          question: "How does CodeSesh stay responsive with a large history?",
          answer:
            "The first scan persists backfill progress and can resume after interruption. Later starts restore from the local SQLite cache, while file watchers incrementally update changed sessions. Long conversation timelines use viewport virtualization instead of rendering every message at once.",
        },
      ],
    },
    cta: {
      title: "Bring your coding history back",
      body: "Open source and free, with session data kept locally. One command starts a searchable engineering memory for your AI coding work.",
      github: "GitHub",
    },
    footer: {
      note: "MIT licensed, with session data and indexes kept local",
      changelog: "Changelog",
      docs: "Docs",
      issues: "Issues",
    },
  },
  ja: {
    meta: {
      title: "CodeSesh：ローカルのAIコーディング履歴を検索・再生",
      description: `CodeSeshは、${agentCount}種類のAIコーディングエージェントのローカルセッションをプロジェクト別に整理し、構造化検索、完全な再生、ローカルSQLiteインデックスを提供します。`,
    },
    header: {
      tour: "製品ツアー",
      capabilities: "機能",
      agents: "対応エージェント",
      changelog: "更新履歴",
      faq: "FAQ",
      github: "GitHub",
      languageLabel: "言語",
      themeLabel: "テーマ",
      themeLight: "ライト",
      themeDark: "ダーク",
      themeSystem: "システム",
      themeSwitchTo: "。クリックして{next}に切り替えます。",
    },
    hero: {
      eyebrow: `ローカル実行 / 設定不要 / ${agentCount}エージェント`,
      title: ["AIとの開発履歴を、", "すべてここに。"],
      body: `CodeSeshは${agentCount}種類のエージェント履歴をプロジェクト別に整理し、ローカルのまま検索・再生できます。`,
      privacy:
        "セッション内容とインデックスはローカルに保持されます。アカウント、クラウド同期、セッションのテレメトリは不要です。",
      command: "npx codesesh",
      endpoint: "http://localhost:4521",
      agentsLabel: "セッションの読み取り元",
      copied: "コピーしました",
      copyFailed: "コピーできませんでした。コマンドを手動でコピーしてください。",
      copyCommand: "コピー",
    },
    tour: {
      previewLabel: "CodeSeshのインタラクティブ製品デモ",
      sampleLabel: "サンプルデータ",
      search: "サンプルセッションを検索",
      range: "サンプルデータの期間",
      overview: "概要のデモ画面",
      projects: "プロジェクトツリーのデモ画面",
      replay: "セッション再生のデモ画面",
      filters: "メッセージ種別の表示と非表示を切り替える",
      visibleStatus: "{count}件のメッセージを表示中",
      userMessages: "ユーザーメッセージ",
      agentResponses: "エージェントの応答",
      toolCalls: "ツール呼び出し",
      sampleProjects: "サンプルプロジェクト",
      sampleSessions: "{label}：サンプルセッション{count}件",
    },
    scenes: [
      {
        title: "今週、何に時間を使ったかがひと目でわかる",
        description:
          "セッション、メッセージ、トークン、コスト、最近のアクティビティを1つのローカルインデックスから表示。期間を変えると、概要全体が再集計されます。",
        hint: "期間を切り替えて、パネル全体が再集計される様子を確認",
      },
      {
        title: "セッションを、本来のプロジェクトへ",
        description:
          "リポジトリとプロジェクト単位で履歴をまとめ、サブエージェントのセッションを親セッションの下に保持。メッセージ、トークン、コストを階層ごとに集計します。",
        hint: "subラベルの付いたセッションを展開し、子エージェントの作業を確認",
      },
      {
        title: "タスクの全工程を時系列で再現",
        description:
          "メッセージ、ツール呼び出し、ファイル変更を発生順に表示。種別フィルターとファイル追跡で、必要なコンテキストをすばやく見つけられます。",
        hint: "ツール呼び出しの出力を展開し、TOCでメッセージ種別を切り替え",
      },
    ],
    features: {
      title: [
        "取り込む、整理する、見つける、振り返る。",
        "4つがそろって、履歴は使える資産になる。",
      ],
      body: "CodeSeshは、AIと進める実際の開発サイクルに沿って機能を構成しています。",
      groups: [
        {
          title: "取り込む",
          description: "異なるエージェントのローカルセッションを1つのインデックスに集約します。",
          items: [
            {
              icon: "settings",
              title: "設定不要",
              description:
                "コマンドを1つ実行するだけで、ファイルシステム上の対応エージェントのセッションを自動検出します。",
            },
            {
              icon: "eye",
              title: "統合タイムライン",
              description: `${agentCount}種類のAIコーディングエージェントの履歴を1つの画面で確認できます。`,
            },
            {
              icon: "timer",
              title: "リアルタイム更新",
              description:
                "ローカルセッションの変更を自動的にインデックスへ反映し、画面を再起動せずに更新します。",
            },
          ],
        },
        {
          title: "整理する",
          description: "セッションをプロジェクト、タスク、開発コンテキストに結び付けます。",
          items: [
            {
              icon: "list-tree",
              title: "プロジェクトとセッションツリー",
              description:
                "リポジトリ別にグループ化し、サブエージェントのセッションを親セッションの下に保持します。",
            },
            {
              icon: "tags",
              title: "スマートタグ",
              description:
                "修正、リファクタリング、機能、テスト、ドキュメント、計画などの作業を自動で分類します。",
            },
            {
              icon: "bookmark",
              title: "セッションの別名",
              description:
                "重要なセッションに覚えやすい名前を付け、検索やブックマークでも同じ名前を使えます。",
            },
          ],
        },
        {
          title: "見つける",
          description: "過去の判断、手順、コンテキストを現在のタスクに呼び戻します。",
          items: [
            {
              icon: "search",
              title: "構造化グローバル検索",
              description:
                "タイトル、メッセージ、ツール出力、ファイルパスを検索し、プロジェクト、タグ、ツールで絞り込めます。",
            },
            {
              icon: "list-tree",
              title: "ファイルアクティビティ索引",
              description:
                "ファイルを起点に、そのファイルを読み取りまたは変更したセッションを探せます。",
            },
            {
              icon: "keyboard",
              title: "キーボード操作",
              description:
                "表示の切り替え、検索へのフォーカス、グループ間の移動をキーボードだけで行えます。",
            },
          ],
        },
        {
          title: "振り返る",
          description: "問題の発見から結果に至るまで、タスクの全工程を再現します。",
          items: [
            {
              icon: "terminal",
              title: "会話全体の再生",
              description: "メッセージ、ツール呼び出し、推論ステップを発生順に確認できます。",
            },
            {
              icon: "bar-chart-3",
              title: "コストとトークンの可視化",
              description:
                "トークン、キャッシュヒット、記録済みコスト、モデル別の推定値を並べて確認できます。",
            },
            {
              icon: "database",
              title: "ローカルSQLiteインデックス",
              description:
                "1つのローカルデータベースで、高速な復元、検索、スキーマ移行を支えます。",
            },
          ],
        },
      ],
    },
    agents: {
      title: ["ローカルのAIコーディング環境を", "まとめてカバー"],
      body: "各エージェントはコアアダプターを通じて接続され、セッション、プロジェクト、検索、ファイルアクティビティを1つのインデックスに集約します。",
    },
    faq: {
      title: "よくある質問",
      body: "CodeSeshの用途、インストール方法、データの取り扱い、大規模な履歴について説明します。",
      items: [
        {
          question: "CodeSeshとは何ですか？",
          answer: `CodeSeshは、AIコーディングのセッション履歴を検出、集約、検索、再生するためのローカル開発者ツールです。${agentNamesJa}のローカル記録を、プロジェクトに結び付いた開発履歴として整理します。`,
        },
        {
          question: "CodeSeshはローカルのAIセッションデータをアップロードしますか？",
          answer:
            "いいえ。CodeSeshはローカルSQLiteインデックスとlocalhostで動作するWeb UIを使用します。セッション内容、ファイルパス、トークン統計、記録済みコストは端末内に保持されます。アカウント、クラウド同期、セッションのテレメトリは必要ありません。",
        },
        {
          question: "CodeSeshをインストールして起動するには？",
          answer:
            "ターミナルでnpx codeseshを実行してください。対応するローカルAIコーディングセッションをスキャンし、http://localhost:4521 でWeb UIを開きます。既定のポートが使用中の場合は、次に利用可能なポートを試します。公開版CLIにはNode.js 22以降が必要です。",
        },
        {
          question: "大量の履歴があっても快適に動作しますか？",
          answer:
            "初回スキャンではバックフィルの進捗を保存し、中断後も再開できます。次回以降はローカルSQLiteキャッシュから復元し、ファイル監視によって変更されたセッションだけを増分更新します。長い会話は、すべてのメッセージを一度に描画せず、表示領域に合わせて仮想化されます。",
        },
      ],
    },
    cta: {
      title: "コーディング履歴を、今すぐ取り戻そう",
      body: "オープンソースで無料。セッションデータはローカルに保持されます。コマンド1つで、AIとの開発履歴を検索できるようになります。",
      github: "GitHub",
    },
    footer: {
      note: "MITライセンス。セッションデータとインデックスはローカルに保持",
      changelog: "更新履歴",
      docs: "ドキュメント",
      issues: "問題を報告",
    },
  },
} satisfies Record<Locale, LandingCopy>;
