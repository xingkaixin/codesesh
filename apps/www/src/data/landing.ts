export type Locale = "en" | "zh";

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
  image: string;
  title: string;
  description: string;
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
    github: string;
    languageLabel: string;
  };
  hero: {
    title: HeadingCopy;
    latest: string;
    body: string;
    commandTitle: string;
    command: string;
    copied: string;
    copyFailed: string;
    copyCommand: string;
    runtime: string;
  };
  tour: {
    label: string;
    title: HeadingCopy;
    body: string;
    expand: string;
    close: string;
    previous: string;
    next: string;
    closeHint: string;
  };
  scenes: ProductScene[];
  features: {
    label: string;
    title: HeadingCopy;
    body: string;
    groups: FeatureGroup[];
  };
  agents: {
    label: string;
    title: HeadingCopy;
    body: string;
  };
  faq: {
    label: string;
    title: HeadingCopy;
    body: string;
    items: FAQItem[];
  };
}

export const siteUrl = "https://codesesh.xingkaixin.me";

export const localeRoutes = {
  en: "/",
  zh: "/zh/",
} satisfies Record<Locale, string>;

export const agents = [
  { name: "Claude Code", icon: "/icon/agent/claudecode.svg" },
  { name: "Cursor", icon: "/icon/agent/cursor.svg" },
  { name: "Kimi", icon: "/icon/agent/kimi.svg" },
  { name: "Codex", icon: "/icon/agent/codex.svg" },
  { name: "Pi", icon: "/icon/agent/pi.svg" },
  { name: "OpenCode", icon: "/icon/agent/opencode.svg" },
  { name: "ZCode", icon: "/icon/agent/zcode.svg" },
] as const;

export const copy = {
  zh: {
    meta: {
      title: "CodeSesh：可复用的 AI 编码工程记忆",
      description:
        "CodeSesh 把 Claude Code、Cursor、Kimi、Codex、Pi、OpenCode 和 ZCode 的本地 AI 编码历史，沉淀成按项目组织、可结构化检索、可复盘的工程记忆。",
    },
    header: {
      github: "GitHub",
      languageLabel: "语言",
    },
    hero: {
      title: ["把 AI 编码历史，", "变成可复用的工程记忆。"],
      latest: "最新版",
      body: "CodeSesh 自动发现 Claude Code、Cursor、Kimi、Codex、Pi、OpenCode 和 ZCode 的本地会话，把问题、推理、尝试、文件活动和结果沉淀成按项目组织、可结构化检索、可复盘的工程记忆。",
      commandTitle: "从本地开始积累",
      command: "npx codesesh",
      copied: "已复制",
      copyFailed: "复制失败，请手动复制命令",
      copyCommand: "复制命令",
      runtime: "需要 Node.js 22+ · 从终端本地运行",
    },
    tour: {
      label: "Product Tour",
      title: ["工程记忆", "如何在日常里生长"],
      body: "从全局概览到会话回放，从项目浏览到结构化搜索，CodeSesh 让散落在不同 Agent 里的编码过程重新变得可见。",
      expand: "展开",
      close: "关闭",
      previous: "上一张",
      next: "下一张",
      closeHint: "点击外部关闭",
    },
    scenes: [
      {
        image: "/demo/dashboard.webp",
        title: "工程记忆概览",
        description: "从 Agent 活跃度、Token 趋势、智能标签和收藏会话里看见协作脉络。",
      },
      {
        image: "/demo/search.webp",
        title: "结构化全局搜索",
        description:
          "按标题、消息、工具输出和文件路径检索，并用项目、标签、工具、文件活动和成本缩小范围。",
      },
      {
        image: "/demo/session-detail.webp",
        title: "会话回放",
        description: "按时间线回看消息、工具调用和文件变更，复盘一次功能或 bug 的完整路径。",
      },
      {
        image: "/demo/shortcuts.webp",
        title: "键盘导航",
        description: "在项目、会话和搜索结果之间高效移动，让历史浏览进入日常工作流。",
      },
    ],
    features: {
      label: "Features",
      title: ["围绕长期积累", "设计产品结构"],
      body: "CodeSesh 围绕真实的 AI 协作循环设计：发现、组织、找回、复盘。",
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
              icon: "timer",
              title: "实时刷新",
              description: "本地会话变更自动进入界面，新的协作记录持续写入工程记忆。",
            },
            {
              icon: "eye",
              title: "统一时间线",
              description:
                "在一个界面里浏览 Claude Code、Cursor、Kimi、Codex、Pi、OpenCode 和 ZCode 的历史会话。",
            },
          ],
        },
        {
          title: "组织",
          description: "让会话回到项目、任务和工程语境里。",
          items: [
            {
              icon: "bar-chart-3",
              title: "工程记忆概览",
              description: "跨 Agent 活跃度、模型、Token、智能标签和收藏会话集中呈现。",
            },
            {
              icon: "list-tree",
              title: "项目化会话树",
              description: "按仓库和项目身份组织会话，让记录回到同一个工程现场。",
            },
            {
              icon: "tags",
              title: "智能标签",
              description:
                "自动识别 bug 修复、重构、功能开发、测试、文档、规划、Git、构建和探索类工作。",
            },
          ],
        },
        {
          title: "找回",
          description: "把过去的判断、路径和上下文重新带回当前任务。",
          items: [
            {
              icon: "search",
              title: "结构化全局搜索",
              description:
                "搜索标题、消息、工具输出和文件路径，并按项目、标签、工具、文件活动和成本筛选。",
            },
            {
              icon: "bookmark",
              title: "关键会话收藏",
              description: "保存重要协作记录，让方案、排障路径和关键判断长期可追溯。",
            },
            {
              icon: "keyboard",
              title: "键盘导航",
              description: "用快捷键切换视图、聚焦搜索、移动分组，让复盘和查找保持流畅。",
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
              description: "回看每条消息、工具调用和推理步骤，还原一次任务的推进过程。",
            },
            {
              icon: "list-tree",
              title: "文件活动索引",
              description: "跳转到被读取、编辑、创建、删除或移动的文件，并按文件活动找回相关会话。",
            },
            {
              icon: "bar-chart-3",
              title: "成本与 Token 可见",
              description:
                "查看 Token 总量、缓存 Token、记录成本和基于模型的估算，理解 AI 协作投入。",
            },
            {
              icon: "database",
              title: "SQLite 迁移与本地索引",
              description: "用本地数据库支撑快速恢复、结构化检索、文件活动索引和 schema 迁移。",
            },
            {
              icon: "shield",
              title: "本地私有",
              description: "会话数据留在你的机器上，免账号、免云端同步、免云端遥测。",
            },
          ],
        },
      ],
    },
    agents: {
      label: "Supported Agents",
      title: ["覆盖主流本地", "AI 编码工具"],
      body: "把多 Agent 工作流收束到同一个工程记忆层。",
    },
    faq: {
      label: "FAQ",
      title: "常见问题",
      body: "关于 CodeSesh 的定位、支持范围、安装方式和数据边界的简短回答。",
      items: [
        {
          question: "CodeSesh 是什么？",
          answer:
            "CodeSesh 是一个本地开发者工具，用来发现、聚合、搜索和回放 AI 编码会话历史。它把 Claude Code、Cursor、Kimi、Codex、Pi、OpenCode 和 ZCode 的本地记录整理成一个按项目组织的工程记忆层，帮助开发者找回历史决策、文件活动和完整协作过程。",
        },
        {
          question: "CodeSesh 支持哪些 AI 编码工具？",
          answer:
            "CodeSesh 当前支持 Claude Code、Cursor、Kimi、Codex、Pi、OpenCode 和 ZCode。每个工具通过 core 包里的 Agent 适配器接入，扫描本地会话存储后统一生成会话列表、项目浏览、结构化搜索索引、文件活动、标签、Token 统计和会话详情。",
        },
        {
          question: "CodeSesh 会上传本地 AI 会话数据吗？",
          answer:
            "CodeSesh 运行在用户自己的机器上，使用本地 SQLite 索引和本地 Web UI 浏览会话历史。会话内容、文件路径、Token 统计和成本估算保留在本机，适合希望保留 AI 编码上下文所有权的开发者。",
        },
        {
          question: "如何安装和启动 CodeSesh？",
          answer:
            "最快的启动方式是在终端运行 npx codesesh。CodeSesh 会扫描受支持的本地 AI 编码会话，并在 http://localhost:4521 打开 Web UI；如果默认端口被占用，会自动尝试下一个可用端口。发布版需要 Node.js 22+，源码开发环境使用 Node.js 24 和 pnpm 11.11.0。",
        },
      ],
    },
  },
  en: {
    meta: {
      title: "CodeSesh: Reusable Engineering Memory for AI Coding",
      description:
        "CodeSesh turns local AI coding history from Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode into project-aware, structurally searchable, replayable engineering memory.",
    },
    header: {
      github: "GitHub",
      languageLabel: "Language",
    },
    hero: {
      title: ["Turn AI coding history", "into reusable engineering memory."],
      latest: "Latest",
      body: "CodeSesh discovers local sessions from Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode, then preserves problems, reasoning, attempts, file activity, and outcomes in one project-aware searchable memory layer.",
      commandTitle: "Start from your machine",
      command: "npx codesesh",
      copied: "Copied",
      copyFailed: "Copy failed. Copy the command manually.",
      copyCommand: "Copy command",
      runtime: "Requires Node.js 22+ · Runs locally from your terminal",
    },
    tour: {
      label: "Product Tour",
      title: "How engineering memory compounds in daily work",
      body: "From overview to replay, from project browsing to structured search, CodeSesh makes coding history across agents visible again.",
      expand: "Expand",
      close: "Close",
      previous: "Previous",
      next: "Next",
      closeHint: "Click outside to close",
    },
    scenes: [
      {
        image: "/demo/dashboard.webp",
        title: "Engineering Memory Overview",
        description:
          "See collaboration patterns through agent activity, token trends, smart tags, and bookmarked sessions.",
      },
      {
        image: "/demo/search.webp",
        title: "Structured Global Search",
        description:
          "Search titles, messages, tool output, and file paths, then filter by project, tag, tool, file activity, and cost.",
      },
      {
        image: "/demo/session-detail.webp",
        title: "Session Replay",
        description:
          "Replay messages, tool calls, and file changes in the order a feature or bug fix unfolded.",
      },
      {
        image: "/demo/shortcuts.webp",
        title: "Keyboard Navigation",
        description:
          "Move through projects, sessions, and results efficiently so browsing history fits daily work.",
      },
    ],
    features: {
      label: "Features",
      title: "Designed for long-term accumulation",
      body: "CodeSesh follows the real loop of AI-assisted engineering: discover, organize, recover, and replay.",
      groups: [
        {
          title: "Discover",
          description: "Bring local sessions from different agents into one index.",
          items: [
            {
              icon: "settings",
              title: "Zero Configuration",
              description: "Run one command and scan supported agent sessions on your filesystem.",
            },
            {
              icon: "timer",
              title: "Live Refresh",
              description:
                "Local session changes appear automatically as new collaboration records are written.",
            },
            {
              icon: "eye",
              title: "Unified Timeline",
              description:
                "Browse Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode sessions in one interface.",
            },
          ],
        },
        {
          title: "Organize",
          description: "Put sessions back into project, task, and engineering context.",
          items: [
            {
              icon: "bar-chart-3",
              title: "Engineering Memory Overview",
              description:
                "See cross-agent activity, models, tokens, smart tags, and bookmarked sessions together.",
            },
            {
              icon: "list-tree",
              title: "Project-Aware Session Tree",
              description:
                "Group sessions by repository and project identity across supported agents.",
            },
            {
              icon: "tags",
              title: "Smart Tags",
              description:
                "Label bugfix, refactor, feature, testing, docs, planning, Git, build, and exploration work.",
            },
          ],
        },
        {
          title: "Recover",
          description: "Bring old decisions, paths, and context back into the current task.",
          items: [
            {
              icon: "search",
              title: "Structured Global Search",
              description:
                "Search titles, messages, tool output, and file paths with project, tag, tool, file activity, and cost filters.",
            },
            {
              icon: "bookmark",
              title: "Session Bookmarks",
              description:
                "Save important records so solutions, debugging paths, and key decisions stay traceable.",
            },
            {
              icon: "keyboard",
              title: "Keyboard Navigation",
              description:
                "Move across views, focus search, and navigate groups from the keyboard.",
            },
          ],
        },
        {
          title: "Replay",
          description: "Reconstruct the full path from problem to result.",
          items: [
            {
              icon: "terminal",
              title: "Full Conversation Replay",
              description: "Read every message, tool call, and reasoning step in sequence.",
            },
            {
              icon: "list-tree",
              title: "File Activity Index",
              description:
                "Jump to files that were read, edited, created, deleted, or moved, and recover sessions by file activity.",
            },
            {
              icon: "bar-chart-3",
              title: "Cost & Token Visibility",
              description:
                "See token totals, cache tokens, recorded costs, and model-based estimates.",
            },
            {
              icon: "database",
              title: "SQLite Migrations & Local Index",
              description:
                "Use one local database for fast restore, structured search, file activity indexing, and schema migrations.",
            },
            {
              icon: "shield",
              title: "Local & Private",
              description:
                "Your data stays on your machine. No accounts, cloud sync, or telemetry.",
            },
          ],
        },
      ],
    },
    agents: {
      label: "Supported Agents",
      title: "Built for the local AI coding stack",
      body: "Unify multi-agent workflows into one engineering memory layer.",
    },
    faq: {
      label: "FAQ",
      title: "Frequently asked questions",
      body: "Short answers about what CodeSesh is, what it supports, and where your data stays.",
      items: [
        {
          question: "What is CodeSesh?",
          answer:
            "CodeSesh is a local developer tool for discovering, aggregating, searching, and replaying AI coding session history. It turns local records from Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode into a project-aware engineering memory layer for recovering decisions, file activity, and complete collaboration paths.",
        },
        {
          question: "Which AI coding tools does CodeSesh support?",
          answer:
            "CodeSesh currently supports Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode. Each tool connects through an agent adapter in the core package, then contributes sessions to unified lists, project browsing, structured search indexes, file activity, smart tags, token statistics, and full replay views.",
        },
        {
          question: "Does CodeSesh upload local AI session data?",
          answer:
            "CodeSesh runs on the user's machine and uses a local SQLite index with a local Web UI. Session content, file paths, token statistics, and cost estimates stay on the local computer, which suits developers who want ownership of AI coding context.",
        },
        {
          question: "How do you install and start CodeSesh?",
          answer:
            "The fastest way to start CodeSesh is running npx codesesh. CodeSesh scans supported local AI coding sessions and opens the Web UI at http://localhost:4521; if that default port is busy, it automatically tries the next available port. The published CLI requires Node.js 22+; source development uses Node.js 24 and pnpm 11.11.0.",
        },
      ],
    },
  },
} satisfies Record<Locale, LandingCopy>;
