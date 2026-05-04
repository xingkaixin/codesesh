declare const __APP_VERSION__: string;

import { useEffect, useState } from "react";
import {
  BarChart3,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Expand,
  Eye,
  Keyboard,
  ListTree,
  Search,
  Settings,
  Shield,
  Tags,
  Terminal,
  Timer,
  type LucideIcon,
} from "lucide-react";

export type Locale = "zh" | "en";

interface ProductScene {
  image: string;
  title: string;
  description: string;
}

interface FeatureItem {
  icon: LucideIcon;
  title: string;
  description: string;
}

interface FeatureGroup {
  title: string;
  description: string;
  items: FeatureItem[];
}

interface TerminalOutputLine {
  segments: {
    text: string;
    className?: string;
  }[];
}

type HeadingCopy = string | string[];

const copy = {
  zh: {
    meta: {
      title: "CodeSesh — 可复用的 AI 编码工程记忆",
      description:
        "CodeSesh 把 Claude Code、Cursor、Kimi、Codex 和 OpenCode 的本地 AI 编码历史，沉淀成可浏览、可检索、可复盘的工程记忆。",
    },
    header: {
      github: "GitHub",
      languageLabel: "语言",
    },
    hero: {
      title: ["把 AI 编码历史，", "变成可复用的", "工程记忆。"],
      latest: "最新版",
      body: "CodeSesh 自动发现 Claude Code、Cursor、Kimi、Codex 和 OpenCode 的本地会话，把问题、推理、尝试、文件变更和结果沉淀成可浏览、可检索、可复盘的工程记忆。",
      commandTitle: "从本地开始积累",
      command: "npx codesesh",
      copied: "已复制",
      copyCommand: "复制命令",
      runtime: "需要 Node.js 18+ · 从终端本地运行",
    },
    terminal: {
      discovered: "123 sessions discovered",
      active: "Local index ready",
    },
    tour: {
      label: "Product Tour",
      title: ["工程记忆", "如何在日常里生长"],
      body: "从全局概览到会话回放，从项目树到全文检索，CodeSesh 让散落在不同 Agent 里的编码过程重新变得可见。",
      expand: "展开",
      close: "关闭",
      previous: "上一张",
      next: "下一张",
      closeHint: "点击外部关闭",
    },
    scenes: [
      {
        image: "/demo/dashboard.png",
        title: "工程记忆概览",
        description: "从 Agent 活跃度、Token 趋势、智能标签和收藏会话里看见协作脉络。",
      },
      {
        image: "/demo/search.png",
        title: "全文检索",
        description: "搜索标题和消息内容，快速回到曾经发生过的工程上下文。",
      },
      {
        image: "/demo/session-detail.png",
        title: "会话回放",
        description: "按时间线回看消息、工具调用和文件变更，复盘一次功能或 bug 的完整路径。",
      },
      {
        image: "/demo/shortcuts.png",
        title: "键盘导航",
        description: "在项目、会话和搜索结果之间高效移动，让历史浏览进入日常工作流。",
      },
    ],
    features: {
      label: "Features",
      title: ["围绕长期积累", "设计产品结构"],
      body: "CodeSesh 的核心工作是发现、组织、找回和复盘。功能说明按这四个阶段展开，让页面信息更接近真实使用路径。",
      groups: [
        {
          title: "发现",
          description: "把不同 Agent 留下的本地会话统一纳入索引。",
          items: [
            {
              icon: Settings,
              title: "零配置启动",
              description: "运行一条命令，自动扫描文件系统里的受支持 Agent 会话。",
            },
            {
              icon: Timer,
              title: "实时刷新",
              description: "本地会话变更自动进入界面，新的协作记录持续写入工程记忆。",
            },
            {
              icon: Eye,
              title: "统一时间线",
              description:
                "在一个界面里浏览 Claude Code、Cursor、Kimi、Codex 和 OpenCode 的历史会话。",
            },
          ],
        },
        {
          title: "组织",
          description: "让会话回到项目、任务和工程语境里。",
          items: [
            {
              icon: BarChart3,
              title: "工程记忆概览",
              description: "跨 Agent 活跃度、模型、Token、智能标签和收藏会话集中呈现。",
            },
            {
              icon: ListTree,
              title: "项目化会话树",
              description: "按仓库和项目身份组织会话，让记录回到同一个工程现场。",
            },
            {
              icon: Tags,
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
              icon: Search,
              title: "全文检索",
              description: "搜索会话标题和对话内容，用高亮结果快速找回工程上下文。",
            },
            {
              icon: Bookmark,
              title: "关键会话收藏",
              description: "保存重要协作记录，让方案、排障路径和关键判断长期可追溯。",
            },
            {
              icon: Keyboard,
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
              icon: Terminal,
              title: "完整会话回放",
              description: "回看每条消息、工具调用和推理步骤，还原一次任务的推进过程。",
            },
            {
              icon: ListTree,
              title: "文件变更追踪",
              description: "跳转到被读取、编辑、创建、删除或移动的文件，把对话和代码变更连起来。",
            },
            {
              icon: BarChart3,
              title: "成本与 Token 可见",
              description:
                "查看 Token 总量、缓存 Token、记录成本和基于模型的估算，理解 AI 协作投入。",
            },
            {
              icon: Database,
              title: "SQLite 本地索引",
              description: "用本地数据库支撑快速恢复和全文检索，让历史会话可以长期积累。",
            },
            {
              icon: Shield,
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
  },
  en: {
    meta: {
      title: "CodeSesh — Reusable Engineering Memory for AI Coding",
      description:
        "CodeSesh turns local AI coding history from Claude Code, Cursor, Kimi, Codex, and OpenCode into browsable, searchable, replayable engineering memory.",
    },
    header: {
      github: "GitHub",
      languageLabel: "Language",
    },
    hero: {
      title: ["Turn AI coding history", "into reusable engineering memory."],
      latest: "Latest",
      body: "CodeSesh discovers local sessions from Claude Code, Cursor, Kimi, Codex, and OpenCode, then preserves problems, reasoning, attempts, file changes, and outcomes in one searchable memory layer.",
      commandTitle: "Start from your machine",
      command: "npx codesesh",
      copied: "Copied",
      copyCommand: "Copy command",
      runtime: "Requires Node.js 18+ · Runs locally from your terminal",
    },
    terminal: {
      discovered: "123 sessions discovered",
      active: "Local index ready",
    },
    tour: {
      label: "Product Tour",
      title: "How engineering memory compounds in daily work",
      body: "From overview to replay, from project trees to full-text search, CodeSesh makes coding history across agents visible again.",
      expand: "Expand",
      close: "Close",
      previous: "Previous",
      next: "Next",
      closeHint: "Click outside to close",
    },
    scenes: [
      {
        image: "/demo/dashboard.png",
        title: "Engineering Memory Overview",
        description:
          "See collaboration patterns through agent activity, token trends, smart tags, and bookmarked sessions.",
      },
      {
        image: "/demo/search.png",
        title: "Full-Text Search",
        description:
          "Search titles and message content to return to the right engineering context.",
      },
      {
        image: "/demo/session-detail.png",
        title: "Session Replay",
        description:
          "Replay messages, tool calls, and file changes in the order a feature or bug fix unfolded.",
      },
      {
        image: "/demo/shortcuts.png",
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
              icon: Settings,
              title: "Zero Configuration",
              description: "Run one command and scan supported agent sessions on your filesystem.",
            },
            {
              icon: Timer,
              title: "Live Refresh",
              description:
                "Local session changes appear automatically as new collaboration records are written.",
            },
            {
              icon: Eye,
              title: "Unified Timeline",
              description:
                "Browse Claude Code, Cursor, Kimi, Codex, and OpenCode sessions in one interface.",
            },
          ],
        },
        {
          title: "Organize",
          description: "Put sessions back into project, task, and engineering context.",
          items: [
            {
              icon: BarChart3,
              title: "Engineering Memory Overview",
              description:
                "See cross-agent activity, models, tokens, smart tags, and bookmarked sessions together.",
            },
            {
              icon: ListTree,
              title: "Project-Aware Session Tree",
              description:
                "Group sessions by repository and project identity across supported agents.",
            },
            {
              icon: Tags,
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
              icon: Search,
              title: "Full-Text Search",
              description: "Search titles and conversation content with highlighted matches.",
            },
            {
              icon: Bookmark,
              title: "Session Bookmarks",
              description:
                "Save important records so solutions, debugging paths, and key decisions stay traceable.",
            },
            {
              icon: Keyboard,
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
              icon: Terminal,
              title: "Full Conversation Replay",
              description: "Read every message, tool call, and reasoning step in sequence.",
            },
            {
              icon: ListTree,
              title: "File Change Tracking",
              description: "Jump to files that were read, edited, created, deleted, or moved.",
            },
            {
              icon: BarChart3,
              title: "Cost & Token Visibility",
              description:
                "See token totals, cache tokens, recorded costs, and model-based estimates.",
            },
            {
              icon: Database,
              title: "SQLite Local Index",
              description:
                "Use one local database for fast session restore and full-text indexing.",
            },
            {
              icon: Shield,
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
  },
};

const agents = [
  { name: "Claude Code", icon: "/icon/agent/claudecode.svg" },
  { name: "Cursor", icon: "/icon/agent/cursor.svg" },
  { name: "Kimi", icon: "/icon/agent/kimi.svg" },
  { name: "Codex", icon: "/icon/agent/codex.svg" },
  { name: "OpenCode", icon: "/icon/agent/opencode.svg" },
];

function getInitialLocale(): Locale {
  if (typeof navigator !== "undefined") {
    const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];

    for (const language of languages) {
      const normalized = language.toLowerCase();
      if (normalized.startsWith("zh")) return "zh";
      if (normalized.startsWith("en")) return "en";
    }
  }

  return "en";
}

function updatePageMeta(locale: Locale) {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.title = copy[locale].meta.title;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", copy[locale].meta.description);
  document
    .querySelector('meta[property="og:title"]')
    ?.setAttribute("content", copy[locale].meta.title);
  document
    .querySelector('meta[property="og:description"]')
    ?.setAttribute("content", copy[locale].meta.description);
  document
    .querySelector('meta[name="twitter:title"]')
    ?.setAttribute("content", copy[locale].meta.title);
  document
    .querySelector('meta[name="twitter:description"]')
    ?.setAttribute("content", copy[locale].meta.description);
}

function HeadingText({ value }: { value: HeadingCopy }) {
  if (Array.isArray(value)) {
    return value.map((line) => (
      <span key={line} className="block">
        {line}
      </span>
    ));
  }

  return value;
}

export function Header({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const t = copy[locale].header;

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--console-border)] bg-white/88 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2 text-[var(--console-text)]">
          <img src="/logo.svg?v=2" alt="CodeSesh" className="h-7 w-7 rounded-sm" />
          <span className="console-mono text-sm font-semibold uppercase tracking-[0.05em]">
            CodeSesh
          </span>
        </a>
        <nav className="flex items-center gap-3">
          <a
            href="https://github.com/xingkaixin/codesesh"
            target="_blank"
            rel="noopener noreferrer"
            className="console-mono text-xs text-[var(--console-muted)] transition-colors hover:text-[var(--console-text)]"
          >
            {t.github}
          </a>
          <div
            className="flex items-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-0.5"
            aria-label={t.languageLabel}
          >
            {(["zh", "en"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onLocaleChange(item)}
                className={`console-mono rounded-[3px] px-2 py-1 text-[10px] font-semibold transition-colors ${
                  locale === item
                    ? "bg-white text-[var(--console-text)] shadow-sm"
                    : "text-[var(--console-muted)] hover:text-[var(--console-text)]"
                }`}
              >
                {item === "zh" ? "中文" : "EN"}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}

export function Hero({ locale }: { locale: Locale }) {
  const [copied, setCopied] = useState(false);
  const t = copy[locale].hero;

  function handleCopy() {
    navigator.clipboard.writeText(t.command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section className="px-6 pb-24 pt-20 md:pt-28">
      <div className="mx-auto grid max-w-6xl min-w-0 items-center gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)]">
        <div className="min-w-0 text-left">
          <VersionStatus label={t.latest} />
          <h1 className="landing-heading max-w-3xl text-[2.25rem] font-semibold leading-[1.08] tracking-tight text-[var(--console-accent-strong)] sm:text-4xl md:text-6xl">
            <HeadingText value={t.title} />
          </h1>
          <p className="mt-7 max-w-2xl text-base leading-8 text-[var(--console-muted)] md:text-lg">
            {t.body}
          </p>

          <div className="mt-10 max-w-xl border-y border-[var(--console-border)] py-5">
            <p className="console-mono text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-muted)]">
              {t.commandTitle}
            </p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <code className="console-mono flex-1 rounded-sm border border-[var(--console-border-strong)] bg-white px-4 py-3 text-sm text-[var(--console-text)]">
                $ {t.command}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="console-mono inline-flex items-center justify-center gap-2 rounded-sm bg-[var(--console-accent-strong)] px-4 py-3 text-xs font-semibold text-white transition-colors hover:bg-black"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? t.copied : t.copyCommand}
              </button>
            </div>
            <p className="mt-3 text-sm leading-6 text-[var(--console-muted)]">{t.runtime}</p>
          </div>
        </div>

        <div className="min-w-0">
          <TerminalCard locale={locale} />
        </div>
      </div>
    </section>
  );
}

function VersionStatus({ label }: { label: string }) {
  return (
    <div className="mb-8 inline-flex items-center gap-3 rounded-sm border border-[var(--console-border-strong)] bg-white px-3.5 py-2 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full rounded-full bg-[#22c55e] opacity-70 animate-status-ping" />
        <span className="relative inline-flex size-2.5 rounded-full bg-[#16a34a]" />
      </span>
      <span className="console-mono text-xs font-bold text-[var(--console-accent-strong)]">
        v{__APP_VERSION__}
      </span>
      <span className="console-mono border-l border-[var(--console-border)] pl-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--console-muted)]">
        {label}
      </span>
    </div>
  );
}

function TerminalCard({ locale }: { locale: Locale }) {
  const t = copy[locale].terminal;
  const command = "$ npx codesesh";
  const outputLines: TerminalOutputLine[] = [
    { segments: [{ text: "\u00A0" }] },
    {
      segments: [{ text: " ╭─────────────CodeSesh───────────────╮", className: "text-[#64748b]" }],
    },
    { segments: [{ text: " │ local session scan", className: "text-[#64748b]" }] },
    {
      segments: [
        { text: " │ ", className: "text-[#64748b]" },
        { text: `v${__APP_VERSION__} • ${t.discovered}`, className: "text-[#e2e8f0]" },
      ],
    },
    { segments: [{ text: " │ SQLite local index ready", className: "text-[#64748b]" }] },
    {
      segments: [{ text: " ╰────────────────────────────────────╯", className: "text-[#64748b]" }],
    },
    { segments: [{ text: "\u00A0" }] },
    {
      segments: [
        { text: " ✔", className: "text-[#4ade80]" },
        { text: " Claude Code 91 sessions" },
      ],
    },
    {
      segments: [
        { text: " ✔", className: "text-[#4ade80]" },
        { text: " Cursor 18 sessions" },
      ],
    },
    {
      segments: [
        { text: " ✔", className: "text-[#4ade80]" },
        { text: " Kimi 2 sessions" },
      ],
    },
    {
      segments: [
        { text: " ✔", className: "text-[#4ade80]" },
        { text: " Codex 30 sessions" },
      ],
    },
    {
      segments: [
        { text: " ✔", className: "text-[#4ade80]" },
        { text: " OpenCode indexed" },
      ],
    },
    { segments: [{ text: "\u00A0" }] },
    {
      segments: [
        { text: "ℹ ", className: "text-[#38bdf8]" },
        { text: t.active, className: "text-[#38bdf8]" },
      ],
    },
    { segments: [{ text: "\u00A0" }] },
    { segments: [{ text: " http://localhost:4321", className: "text-[#38bdf8]" }] },
  ];
  const [entered, setEntered] = useState(false);
  const [commandLength, setCommandLength] = useState(0);
  const [visibleLineCount, setVisibleLineCount] = useState(0);

  useEffect(() => {
    setEntered(false);
    setCommandLength(0);
    setVisibleLineCount(0);

    const prefersReducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (prefersReducedMotion) {
      setEntered(true);
      setCommandLength(command.length);
      setVisibleLineCount(outputLines.length);
      return;
    }

    const timers: number[] = [];
    timers.push(window.setTimeout(() => setEntered(true), 80));

    const typingStart = 360;
    for (let index = 1; index <= command.length; index += 1) {
      timers.push(window.setTimeout(() => setCommandLength(index), typingStart + index * 34));
    }

    const outputStart = typingStart + command.length * 34 + 220;
    outputLines.forEach((_, index) => {
      timers.push(window.setTimeout(() => setVisibleLineCount(index + 1), outputStart + index * 115));
    });

    return () => {
      timers.forEach(window.clearTimeout);
    };
  }, [command.length, locale, outputLines.length]);

  return (
    <div
      className={`min-h-[25rem] rounded-sm border border-[var(--console-border-strong)] bg-[#0f172a] p-4 text-left shadow-[0_24px_80px_rgba(15,23,42,0.18)] transition-all duration-700 ease-out sm:min-h-[29rem] sm:p-5 ${
        entered ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="console-mono inline-block size-2.5 rounded-full bg-[#ef4444]" />
        <span className="console-mono inline-block size-2.5 rounded-full bg-[#eab308]" />
        <span className="console-mono inline-block size-2.5 rounded-full bg-[#22c55e]" />
      </div>
      <pre className="console-mono overflow-x-auto text-xs leading-relaxed text-[#94a3b8] sm:text-sm">
        <span className="font-semibold text-[#4ade80]">{command.slice(0, commandLength)}</span>
        {commandLength < command.length ? (
          <span className="ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-[#4ade80] animate-caret-blink" />
        ) : null}
        {outputLines.slice(0, visibleLineCount).map((line, index) => (
          <TerminalAnimatedLine key={index} line={line} />
        ))}
      </pre>
    </div>
  );
}

function TerminalAnimatedLine({ line }: { line: TerminalOutputLine }) {
  return (
    <span className="block animate-terminal-line">
      {line.segments.map((segment, index) => (
        <span key={`${segment.text}-${index}`} className={segment.className}>
          {segment.text}
        </span>
      ))}
    </span>
  );
}

export function ProductShowcase({ locale }: { locale: Locale }) {
  const [activeSceneIndex, setActiveSceneIndex] = useState<number | null>(null);
  const t = copy[locale].tour;
  const scenes = copy[locale].scenes as ProductScene[];
  const activeScene = activeSceneIndex === null ? null : scenes[activeSceneIndex];

  function openScene(index: number) {
    setActiveSceneIndex(index);
  }

  function closeScene() {
    setActiveSceneIndex(null);
  }

  function showPreviousScene() {
    setActiveSceneIndex((current) => {
      if (current === null) return current;
      return (current - 1 + scenes.length) % scenes.length;
    });
  }

  function showNextScene() {
    setActiveSceneIndex((current) => {
      if (current === null) return current;
      return (current + 1) % scenes.length;
    });
  }

  return (
    <>
      <section className="border-y border-[var(--console-border)] bg-white px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-8 md:grid-cols-[0.78fr_1.22fr] md:items-end">
            <div>
              <p className="console-mono text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
                {t.label}
              </p>
              <h2 className="landing-heading mt-4 max-w-xl text-3xl font-semibold leading-tight tracking-tight text-[var(--console-accent-strong)] md:text-4xl">
                <HeadingText value={t.title} />
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-8 text-[var(--console-muted)]">{t.body}</p>
          </div>

          <div className="mt-14 grid gap-6 lg:grid-cols-2">
            {scenes.map((scene, index) => (
              <ProductSceneCard
                key={scene.title}
                scene={scene}
                expandLabel={t.expand}
                onExpand={() => openScene(index)}
              />
            ))}
          </div>
        </div>
      </section>

      {activeScene ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          onClick={closeScene}
          role="dialog"
          aria-modal="true"
          aria-label={`${activeScene.title} preview`}
        >
          <div
            className="relative flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-md border border-white/20 bg-[#f7f7f7] shadow-[0_40px_120px_rgba(15,23,42,0.45)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--console-border)] bg-white px-5 py-4">
              <div>
                <p className="console-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--console-muted)]">
                  {activeScene.title}
                </p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--console-text)]">
                  {activeScene.description}
                </p>
              </div>
              <button
                type="button"
                onClick={closeScene}
                className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5 text-xs font-medium text-[var(--console-text)] transition-colors hover:bg-white"
              >
                {t.close}
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-[var(--console-border)] bg-[rgba(255,255,255,0.82)] px-4 py-3">
              <button
                type="button"
                onClick={showPreviousScene}
                className="inline-flex items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-3 py-2 text-xs font-medium text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                <ChevronLeft className="size-4" />
                {t.previous}
              </button>
              <p className="console-mono text-[11px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
                {t.closeHint}
              </p>
              <button
                type="button"
                onClick={showNextScene}
                className="inline-flex items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-3 py-2 text-xs font-medium text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                {t.next}
                <ChevronRight className="size-4" />
              </button>
            </div>

            <div className="overflow-auto bg-[var(--console-surface-muted)] p-4">
              <div className="mx-auto min-w-[56rem] overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_20px_60px_rgba(15,23,42,0.12)]">
                <img
                  src={activeScene.image}
                  alt={`${activeScene.title} enlarged preview`}
                  className="h-auto w-full object-cover object-top"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ProductSceneCard({
  scene,
  expandLabel,
  onExpand,
}: {
  scene: ProductScene;
  expandLabel: string;
  onExpand: () => void;
}) {
  return (
    <article className="group relative overflow-hidden rounded-md border border-[var(--console-border)] bg-white text-left shadow-[0_24px_70px_rgba(15,23,42,0.08)]">
      <div className="border-b border-[var(--console-border)] bg-white px-6 py-5">
        <p className="console-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--console-muted)]">
          {scene.title}
        </p>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--console-text)]">
          {scene.description}
        </p>
      </div>

      <div className="bg-[var(--console-surface-muted)] p-4">
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[#f8f8f8]">
          <img
            src={scene.image}
            alt={`${scene.title} demo`}
            className="aspect-[1586/992] h-auto w-full object-cover object-top"
            loading="lazy"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onExpand}
        className="absolute right-6 bottom-6 inline-flex items-center gap-2 rounded-sm border border-white/70 bg-white/92 px-3 py-2 text-xs font-medium text-[var(--console-text)] opacity-0 shadow-lg transition-all duration-200 group-hover:opacity-100 group-focus-within:opacity-100 hover:scale-[1.02]"
        aria-label={`${expandLabel} ${scene.title}`}
      >
        <Expand className="size-3.5" />
        {expandLabel}
      </button>
    </article>
  );
}

export function Features({ locale }: { locale: Locale }) {
  const t = copy[locale].features;

  return (
    <section className="px-6 py-24" aria-label={t.label}>
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.78fr_1.22fr]">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="console-mono text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
            {t.label}
          </p>
          <h2 className="landing-heading mt-4 max-w-md text-3xl font-semibold leading-tight tracking-tight text-[var(--console-accent-strong)] md:text-4xl">
            <HeadingText value={t.title} />
          </h2>
          <p className="mt-5 max-w-md text-base leading-8 text-[var(--console-muted)]">{t.body}</p>
        </div>

        <div className="space-y-5">
          {t.groups.map((group) => (
            <FeatureGroupCard key={group.title} group={group} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureGroupCard({ group }: { group: FeatureGroup }) {
  return (
    <article className="rounded-md border border-[var(--console-border)] bg-white p-6">
      <div className="grid gap-6 md:grid-cols-[0.42fr_0.58fr]">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-[var(--console-text)]">
            {group.title}
          </h3>
          <p className="mt-3 text-sm leading-7 text-[var(--console-muted)]">{group.description}</p>
        </div>

        <ul className="space-y-4">
          {group.items.map((item) => (
            <li key={item.title} className="grid grid-cols-[2rem_1fr] gap-3">
              <div className="flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                <item.icon className="size-4 text-[var(--console-accent)]" />
              </div>
              <div>
                <h4 className="console-mono text-xs font-bold text-[var(--console-text)]">
                  {item.title}
                </h4>
                <p className="mt-1 text-sm leading-6 text-[var(--console-muted)]">
                  {item.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function Agents({ locale }: { locale: Locale }) {
  const t = copy[locale].agents;

  return (
    <section
      className="border-t border-[var(--console-border)] bg-white px-6 py-20"
      aria-label={t.label}
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-8 md:grid-cols-[0.75fr_1.25fr] md:items-end">
          <div>
            <p className="console-mono text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
              {t.label}
            </p>
            <h2 className="landing-heading mt-4 max-w-lg text-3xl font-semibold leading-tight tracking-tight text-[var(--console-accent-strong)] md:text-4xl">
              <HeadingText value={t.title} />
            </h2>
          </div>
          <p className="max-w-2xl text-base leading-8 text-[var(--console-muted)]">{t.body}</p>
        </div>

        <ul className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {agents.map((a) => (
            <li
              key={a.name}
              className="flex items-center gap-3 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-4 py-4"
            >
              <img
                src={a.icon}
                alt={a.name}
                className="size-8 object-contain"
                width="32"
                height="32"
                loading="lazy"
              />
              <span className="console-mono text-xs font-semibold text-[var(--console-text)]">
                {a.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-[var(--console-border)] px-6 py-8">
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <span className="console-mono text-xs text-[var(--console-muted)]">CodeSesh</span>
        <span className="console-mono text-xs text-[var(--console-muted)]">
          &copy; {new Date().getFullYear()}
        </span>
      </div>
    </footer>
  );
}

export function useLandingLocale() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);

  useEffect(() => {
    updatePageMeta(locale);
  }, [locale]);

  return [locale, setLocale] as const;
}
