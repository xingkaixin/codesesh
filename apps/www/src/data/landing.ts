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
    tour: string;
    capabilities: string;
    agents: string;
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
    docs: string;
    issues: string;
  };
}

export const siteUrl = "https://codesesh.xingkaixin.me";

export const localeRoutes = {
  en: "/",
  zh: "/zh/",
} satisfies Record<Locale, string>;

export const agents = [
  { name: "Claude Code", icon: "/icon/agent/claudecode.svg", iconColored: true },
  { name: "Cursor", icon: "/icon/agent/cursor.svg" },
  { name: "Kimi", icon: "/icon/agent/kimi.svg" },
  { name: "Kimi-Code", icon: "/icon/agent/kimi.svg" },
  { name: "Codex", icon: "/icon/agent/codex.svg" },
  { name: "Grok", icon: "/icon/agent/grok.svg" },
  { name: "Pi", icon: "/icon/agent/pi.svg" },
  { name: "OpenCode", icon: "/icon/agent/opencode.svg" },
  { name: "ZCode", icon: "/icon/agent/zcode.svg" },
] as const;

export const copy = {
  zh: {
    meta: {
      title: "CodeSesh：搜索与回放本地 AI 编码历史",
      description:
        "CodeSesh 把九种 AI 编码 Agent 的本地会话按项目组织，提供结构化搜索、完整回放与本地 SQLite 索引，让工程上下文可查、可追溯。",
    },
    header: {
      tour: "产品导览",
      capabilities: "能力",
      agents: "支持的 Agent",
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
      eyebrow: "本地运行 / 零配置 / 9 个 Agent",
      title: ["你和 AI 写过的", "每一次对话，都还在。"],
      body: "CodeSesh 扫描九种 AI 编码 Agent 的本地会话，把分散的历史收进同一个索引：按项目组织、结构化搜索、逐条回放。",
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
    },
    scenes: [
      {
        title: "打开就知道这周花在哪儿了",
        description:
          "会话、消息、Token、成本与最近活跃都来自同一个本地索引。切换时间窗口，概览同步重算。",
      },
      {
        title: "会话回到它该在的项目里",
        description:
          "按仓库和项目身份归组，子 Agent 会话保留在父会话下，消息、Token 与成本按层级汇总。",
      },
      {
        title: "一次任务的完整路径逐条还原",
        description:
          "消息、工具调用和文件变更按发生顺序呈现，类型过滤与文件追踪帮助你快速定位关键上下文。",
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
              description: "九种 Agent 的历史会话进入同一个界面。",
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
          answer:
            "CodeSesh 是一个本地开发者工具，用来发现、聚合、搜索和回放 AI 编码会话历史。它把 Claude Code、Cursor、Kimi、Kimi-Code、Codex、Grok、Pi、OpenCode 和 ZCode 的本地记录整理成按项目组织的工程记忆层。",
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
      github: "在 GitHub 上查看",
    },
    footer: {
      note: "MIT 许可，会话数据与索引保留在本机",
      docs: "文档",
      issues: "问题反馈",
    },
  },
  en: {
    meta: {
      title: "CodeSesh: Search and Replay Local AI Coding History",
      description:
        "CodeSesh organizes local sessions from nine AI coding agents by project, with structured search, full replay, and a local SQLite index.",
    },
    header: {
      tour: "Tour",
      capabilities: "Capabilities",
      agents: "Agents",
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
      eyebrow: "Local / Zero config / 9 agents",
      title: ["Every AI coding session", "is still here."],
      body: "CodeSesh scans local histories from nine AI coding agents and puts them in one index: organized by project, structurally searchable, and replayable message by message.",
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
    },
    scenes: [
      {
        title: "Open it and see where the week went",
        description:
          "Sessions, messages, tokens, cost, and recent activity come from one local index. Change the time window and the overview recomputes.",
      },
      {
        title: "Sessions go back where they belong",
        description:
          "Group history by repository and project, keep subagent sessions under their parent, and aggregate messages, tokens, and cost by hierarchy.",
      },
      {
        title: "Replay the complete path of a task",
        description:
          "Read messages, tool calls, and file changes in sequence, then use type filters and file tracking to find the context that matters.",
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
              description: "Browse histories from nine AI coding agents in one interface.",
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
          answer:
            "CodeSesh is a local developer tool for discovering, aggregating, searching, and replaying AI coding session history. It turns local records from Claude Code, Cursor, Kimi, Kimi-Code, Codex, Grok, Pi, OpenCode, and ZCode into a project-aware engineering memory layer.",
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
      github: "View on GitHub",
    },
    footer: {
      note: "MIT licensed, with session data and indexes kept local",
      docs: "Docs",
      issues: "Issues",
    },
  },
} satisfies Record<Locale, LandingCopy>;
