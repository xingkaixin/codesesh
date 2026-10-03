import { localeConfig, locales, siteUrl, type Locale } from "./landing";

export interface ChangelogHighlight {
  title: string;
  description: string;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  title: string;
  summary: string;
  direction: string;
  highlights: ChangelogHighlight[];
}

interface ChangelogCopy {
  meta: {
    title: string;
    description: string;
  };
  navigation: string;
  hero: {
    title: string;
    body: string;
  };
  latest: {
    label: string;
    title: string;
    body: string;
    link: string;
  };
  release: {
    historyLabel: string;
    changed: string;
    direction: string;
    details: string;
  };
  releases: ChangelogRelease[];
}

export const changelogRoutes = {
  en: "/changelog/",
  zh: "/zh/changelog/",
  ja: "/ja/changelog/",
} satisfies Record<Locale, string>;

export const changelogCopy = {
  en: {
    meta: {
      title: "CodeSesh Changelog | Product Updates and Direction",
      description:
        "Read the CodeSesh changelog to see what changed, why each release matters, and how the local AI coding history viewer is becoming faster and safer.",
    },
    navigation: "Changelog",
    hero: {
      title: "What changed, and where CodeSesh is going",
      body: "The CodeSesh product changelog explains user-visible improvements in plain language. Each release covers what changed, why it matters for local AI coding history, and the product direction behind the work.",
    },
    latest: {
      label: "Latest update",
      title: "Follow the product, not the commit log",
      body: "See the improvements that change how CodeSesh feels to use, plus the principles guiding what we build next.",
      link: "Read the product changelog",
    },
    release: {
      historyLabel: "Release history",
      changed: "What changed",
      direction: "Product direction",
      details: "View technical release details",
    },
    releases: [
      {
        version: "1.2.6",
        date: "2026-10-03",
        title: "Catch up on history with clearer rescan progress",
        summary:
          "CodeSesh 1.2.6 reduces idle waits while Workers collect and upload AI coding history. Rescan tasks now explain what triggered them and show available scan counts, making long recovery tasks easier to follow.",
        direction:
          "Multi-machine history should catch up without unnecessary delays and show progress that reflects work already saved and confirmed.",
        highlights: [
          {
            title: "Keep history collection and uploads moving",
            description:
              "Workers continue scanning unfinished history and send the next queued upload as soon as the previous one is confirmed. Failed requests still wait before retrying, and pending content stays saved locally.",
          },
          {
            title: "Understand why a rescan started",
            description:
              "Task details distinguish a manual rescan from Hub recovery or Worker replacement, so an automatic recovery is easier to understand.",
          },
          {
            title: "See scanning and upload confirmation separately",
            description:
              "Available progress shows scanned source items for a pending Agent. Older or offline reports are not presented as current counts, and a task finishes only after its uploads are confirmed.",
          },
        ],
      },
      {
        version: "1.2.5",
        date: "2026-10-03",
        title: "Resume Worker synchronization after interrupted recovery",
        summary:
          "CodeSesh 1.2.5 fixes Workers that stay paused when the Hub changes again during recovery. They can reconnect to the verified Hub and continue uploading queued AI coding history, including when restarting the Worker previously left it stuck.",
        direction:
          "Multi-machine history should recover from interrupted synchronization while preserving work already collected and verifying the destination Hub.",
        highlights: [
          {
            title: "Recover from stale synchronization state",
            description:
              "Workers refresh their recovery state when the Hub changes again, instead of repeatedly retrying an outdated recovery and remaining offline in the Hub.",
          },
          {
            title: "Keep queued history available for upload",
            description:
              "Recovery preserves queued session content even if the source log is no longer available. It also handles a lost recovery acknowledgment followed by another Hub change.",
          },
        ],
      },
      {
        version: "1.2.4",
        date: "2026-10-03",
        title: "Find the right message and read long conversations in stages",
        summary:
          "CodeSesh 1.2.4 finds Chinese terms inside continuous text and opens message search results at the matching message. Long conversations load in pages, source machines are clearer, and browsing and synchronization do less repeated work as local AI coding history grows.",
        direction:
          "Growing history should remain practical to search and read. Load what the reader needs, preserve the complete conversation, and make its source clear.",
        highlights: [
          {
            title: "Search Chinese text and open the matching message",
            description:
              "Find short Chinese terms within longer text and jump from a message result to its first match. Search explains the active scope, time range, and 50-session display limit so you can refine the results.",
          },
          {
            title: "Read long conversations without loading everything first",
            description:
              "Messages load in pages as you approach the bottom. Retry a failed page or choose Load all messages, while keeping your reading position. Markdown copying and receipts still use the complete conversation.",
          },
          {
            title: "Know which machine a session belongs to",
            description:
              "Search results identify the source machine. Session details show its sync status and explain where to run a copied resume command, helping you return to the right environment.",
          },
          {
            title: "Reduce repeated work as history grows",
            description:
              "CodeSesh reuses unchanged messages and list pages, limits statistics reads to the selected sessions, and reduces temporary memory used by Hub/Worker synchronization.",
          },
        ],
      },
      {
        version: "1.2.3",
        date: "2026-10-01",
        title: "Read conversations, code results, and answers more clearly",
        summary:
          "CodeSesh 1.2.3 makes local AI coding history easier to replay with readable tables, Code Mode text and images, and Codex thread excerpts and question answers. Opening an old Codex chat no longer changes its recorded activity time.",
        direction:
          "Session replay should preserve the conversation, tool results, and user decisions, while recent activity should reflect the work recorded by the source.",
        highlights: [
          {
            title: "Review Codex threads and recorded answers",
            description:
              "Read user messages and final replies from thread lookups, expand more turns when needed, and see asynchronous questions alongside the user's recorded answers.",
          },
          {
            title: "Inspect Code Mode output and source",
            description:
              "DeepChat, Codex, and Pi Code Mode calls show text and images in their original order. Expand and copy the source, inspect failures, and review available Pi execution details.",
          },
          {
            title: "Read tables and trust recent activity",
            description:
              "Agent replies render Markdown tables with scrolling contained inside the message. Codex settings and other metadata no longer move old chats into recent activity; the next scan corrects saved timestamps.",
          },
        ],
      },
      {
        version: "1.2.2",
        date: "2026-10-01",
        title: "Load dashboards with less work as history grows",
        summary:
          "CodeSesh 1.2.2 reduces the data read when opening dashboards and bookmarks in large local or Hub archives. More complete loading diagnostics help investigate pages that remain slow.",
        direction:
          "As AI coding history grows, everyday browsing should read only the data it needs, and loading problems should be traceable.",
        highlights: [
          {
            title: "Read less when opening saved history",
            description:
              "Dashboard queries use indexes for session summaries, usage, and activity. Bookmarks load their saved sessions without reading the full archive.",
          },
          {
            title: "Diagnose the complete page load",
            description:
              "Loading logs now cover projects, the dashboard, and bookmarks alongside sessions. Slow query logs show where time is spent, helping diagnose delays on a local server or Hub.",
          },
        ],
      },
      {
        version: "1.2.1",
        date: "2026-09-29",
        title: "Keep Worker uploads moving as session counts change",
        summary:
          "CodeSesh 1.2.1 fixes a Hub/Worker sync failure when a session's message count changes but its replayable conversation stays the same. These updates no longer block queued uploads.",
        direction:
          "Reliable multi-machine history depends on accepting valid session updates while preserving the conversation already collected.",
        highlights: [
          {
            title: "Sync session counts without blocking uploads",
            description:
              "The Hub now accepts count changes in metadata-only updates, including when Codex records new environment context or developer instructions without adding replayable messages.",
          },
          {
            title: "Keep existing conversation content intact",
            description:
              "The Hub saves the updated count without rewriting stored messages or search content, preserving the conversation available for replay and search.",
          },
        ],
      },
      {
        version: "1.2.0",
        date: "2026-09-29",
        title: "Browse AI coding history across your machines",
        summary:
          "CodeSesh 1.2.0 adds an optional self-hosted Hub and Workers. Collect local AI coding history from multiple machines into one searchable Web UI while keeping each source distinct.",
        direction:
          "History should remain searchable as work moves between machines, with explicit control over where sessions are sent and clear visibility into collection problems.",
        highlights: [
          {
            title: "Bring multiple machines into one view",
            description:
              "Pair Workers with your Hub and filter sessions by source. Standalone mode remains available; Workers send session content and metadata to the Hub you choose.",
          },
          {
            title: "See collection problems and request rescans",
            description:
              "Inspect queue status and Agent errors, queue rescans for selected Agents, and review task history. Offline Workers can collect changes for later upload.",
          },
          {
            title: "Replace a Worker without losing its identity",
            description:
              "Guided pairing covers local, LAN, and public HTTPS connections. Replace a Worker while retaining its archived history, bookmarks, aliases, and project groups.",
          },
          {
            title: "Install and manage local data more easily",
            description:
              "New native installation channels include curl, Homebrew, and Scoop. Databases, pricing cache, and logs move into ~/.codesesh/ with a guided migration from older locations.",
          },
        ],
      },
      {
        version: "1.1.1",
        date: "2026-09-27",
        title: "Understand session costs and save the full receipt",
        summary:
          "CodeSesh 1.1.1 adds model and token-category details to session receipts and lets you save the complete receipt as a PNG. Reopening local AI coding history also reads less cached metadata.",
        direction:
          "Session costs should be easy to inspect and save, with estimates and missing details clearly identified. Browsing saved history should only load the data it needs.",
        highlights: [
          {
            title: "See where session usage comes from",
            description:
              "Review usage and available costs by model and provider, including uncached input, output, cache reads, and cache writes. Estimated costs are labeled, and unavailable details remain unspecified.",
          },
          {
            title: "Save the complete receipt",
            description:
              "Export a CodeSesh-branded PNG that includes the entire receipt, even when its details extend beyond the visible drawer.",
          },
          {
            title: "Load less data when reopening history",
            description:
              "Session lists restore from compact display metadata, avoiding a read of pricing details that the list does not need.",
          },
        ],
      },
      {
        version: "1.1.0",
        date: "2026-09-26",
        title: "Run local AI coding history with a native backend",
        summary:
          "CodeSesh 1.1.0 brings a native backend with the Web UI built in. Standalone executables run without Node.js, while background pricing updates let you browse saved sessions without waiting for a price download.",
        direction:
          "Local AI coding history should be straightforward to run, and opening saved work should not depend on a pricing service.",
        highlights: [
          {
            title: "Choose a standalone executable or npm",
            description:
              "Use a native executable on supported macOS, Linux, and Windows systems, or keep launching with npx codesesh. The npm launcher requires Node.js 22 or later.",
          },
          {
            title: "Keep browsing while prices refresh",
            description:
              "Model prices refresh in the background. Updated estimates use cached usage instead of rereading your conversation files.",
          },
          {
            title: "Reuse work when reopening your history",
            description:
              "Cached session metadata, incremental scans, and reduced snapshot decoding work limit what CodeSesh needs to process again at startup.",
          },
        ],
      },
      {
        version: "1.0.12",
        date: "2026-09-24",
        title: "Keep browsing your history after moving to OpenCode V2",
        summary:
          "CodeSesh now supports OpenCode V2 history based on version 2.0.15, while retaining V1 support. Review conversations, reasoning, and tool results, keep fork usage from being counted twice, and refresh cached history when you select a different database.",
        direction:
          "Local AI coding history should remain useful as tools change their storage formats, preserving conversation context and the usage recorded by each source.",
        highlights: [
          {
            title: "Replay OpenCode V2 conversations",
            description:
              "Search and replay saved messages, reasoning, tool results, child sessions, and compaction records. Copy a resume command to continue a session in OpenCode.",
          },
          {
            title: "Usage that respects forks and subtasks",
            description:
              "Session usage and costs follow OpenCode's recorded totals, so copied fork history and child-session usage are not counted again. Explicit zero costs stay zero.",
          },
          {
            title: "History follows your selected database",
            description:
              "Choose a custom OpenCode database and keep saved message changes in sync. Switching database paths refreshes cached sessions even when the selected database is older than the last scan.",
          },
        ],
      },
      {
        version: "1.0.11",
        date: "2026-09-21",
        title: "Exit cleanly while background work is running",
        summary:
          "Pressing Ctrl+C now cancels background refreshes and history backfills without misleading failure messages. CodeSesh keeps the existing session view intact, while real errors continue to be reported.",
        direction:
          "Routine actions should give clear feedback, so messages about local AI coding history point to problems that need attention.",
        highlights: [
          {
            title: "Stop a background refresh without an error stack",
            description:
              "Closing CodeSesh while sessions are being scanned or indexed no longer prints a session refresh failure caused by the shutdown itself.",
          },
          {
            title: "Cancel history backfills with the same clear feedback",
            description:
              "Stopping while older sessions are being loaded follows the same cancellation handling, keeping expected shutdowns out of failure reports.",
          },
        ],
      },
      {
        version: "1.0.10",
        date: "2026-09-21",
        title: "Browse MiniMax Code history alongside your other sessions",
        summary:
          "CodeSesh now brings MiniMax Code CLI 0.4.12 history into your local AI coding history view, with parent and child sessions, reasoning, tool details, and usage. Saved message changes stay in sync, and the product site's mobile hero artwork takes up less vertical space.",
        direction:
          "Adding a local tool should preserve its conversation structure and saved changes, so you can follow the work and return to a session with its context intact.",
        highlights: [
          {
            title: "Follow MiniMax Code sessions and subtasks",
            description:
              "Browse parent and child conversations, review reasoning, tool details, and usage, and copy a resume command to continue a session in MiniMax Code.",
          },
          {
            title: "Keep saved history current",
            description:
              "Automatic refresh picks up new messages, edits, and deletions in MiniMax Code, including writes that directory watchers can miss.",
          },
          {
            title: "More room for content on mobile",
            description:
              "The product site's opening artwork is shorter on mobile screens, leaving more space for the page content.",
          },
        ],
      },
      {
        version: "1.0.9",
        date: "2026-09-19",
        title: "Bring DeepChat and Cherry Studio history into one view",
        summary:
          "CodeSesh now includes DeepChat and Cherry Studio conversations alongside your other local AI coding history. Session layouts are easier to read, small costs remain visible, and Claude Code refreshes remove cached entries from data directories you no longer use.",
        direction:
          "Support for more local tools should preserve each source’s conversation structure and usage records, with clear guidance on what can be found and replayed.",
        highlights: [
          {
            title: "DeepChat conversations alongside your coding sessions",
            description:
              "Browse native and ACP sessions from DeepChat’s current unencrypted local database, replay messages, and review usage as records update.",
          },
          {
            title: "Cherry Studio Agent sessions and assistant chats",
            description:
              "Read Cherry Studio 2.x Agent sessions with their workspaces and follow the selected branch of assistant chats, with usage tied to that branch.",
          },
          {
            title: "Clearer dates, messages, and small costs",
            description:
              "Date separators and layouts that adapt to narrower screens make long conversations easier to follow. Positive costs below one cent are shown as <$0.01 instead of $0.00.",
          },
          {
            title: "Guides to finding your local history",
            description:
              "English, Chinese, and Japanese guides explain where Claude Code and Codex records live, how to search and replay them, and what to check when a session is missing.",
          },
        ],
      },
      {
        version: "1.0.8",
        date: "2026-09-13",
        title: "See how token usage is split across models",
        summary:
          "Overview and project dashboards now show each model’s token total and share for the selected date range, including cache tokens. Navigation gains consistent hover feedback, and the product site updates its celestial visuals and asset loading.",
        direction:
          "Local AI coding history should make usage comparisons easy to read and keep every breakdown tied to the time range you choose.",
        highlights: [
          {
            title: "Model token shares",
            description:
              "Compare model token totals and percentages in overview and project dashboards, with details available by pointer or keyboard.",
          },
          {
            title: "Usage within your selected dates",
            description:
              "Model totals follow the dashboard date range, so activity outside that range no longer enters the comparison.",
          },
          {
            title: "Consistent navigation and lighter loading",
            description:
              "Navigation gains shared hover feedback, agent introduction pages load on demand, and product site assets use caching and homepage artwork preloading.",
          },
        ],
      },
      {
        version: "1.0.7",
        date: "2026-09-08",
        title: "Active hours overview and more resilient live sync",
        summary:
          "The Overview dashboard now features an active hours breakdown to visualize your coding rhythm across the day. Real-time updates recover cleanly from disconnections and transient errors, unavailable sessions remain retryable, and custom session aliases are preserved throughout live streams.",
        direction:
          "A local coding history tool should reveal personal development patterns without friction, and live synchronization must remain rock-solid regardless of connection flickers or heavy background updates.",
        highlights: [
          {
            title: "Active hours by time of day",
            description:
              "See when you collaborate with AI agents throughout the day, grouped by morning, afternoon, and evening periods with intensity cues.",
          },
          {
            title: "Resilient live synchronization",
            description:
              "Reconnection and transient stream failures recover automatically, keeping session lists and dashboard aggregates in sync without manual reloads.",
          },
          {
            title: "Retryable sessions and durable aliases",
            description:
              "Temporarily unavailable session details can be retried directly, and custom session aliases remain intact during concurrent live updates.",
          },
        ],
      },
      {
        version: "1.0.6",
        date: "2026-09-05",
        title: "Localized interface and faster history analytics",
        summary:
          "CodeSesh now speaks English, Simplified Chinese, and Japanese with persistent language preferences. Model pricing updates automatically from models.dev for accurate cost estimates, while full-history analytics and session hierarchy browsing are substantially faster.",
        direction:
          "A local history viewer should feel natural in your primary language and stay instantaneous even after months of heavy agent use.",
        highlights: [
          {
            title: "Native trilingual interface",
            description:
              "Switch seamlessly between English, Simplified Chinese, and Japanese with preferences saved across sessions, while session transcripts and code remain in their original form.",
          },
          {
            title: "Live-updated model pricing",
            description:
              "Automatically caches up-to-date pricing from models.dev before scanning, keeping token cost tracking accurate as model catalogs expand.",
          },
          {
            title: "Faster full-history analytics",
            description:
              "Database-indexed usage queries and streamlined tree traversal deliver snappy dashboard metrics and smoother browsing across large archives.",
          },
        ],
      },
      {
        version: "1.0.5",
        date: "2026-08-31",
        title: "Faster refreshes and more dependable live state",
        summary:
          "Large histories now refresh by updating only changed search documents, while cold session details load in background workers. You can also copy any session as clean Markdown from its action menu.",
        direction:
          "CodeSesh should stay responsive as local histories grow, and its live scan and session state should always be easy to trust.",
        highlights: [
          {
            title: "Copy sessions as Markdown",
            description:
              "Move a complete conversation into documentation, an issue, or another tool without rebuilding its structure by hand.",
          },
          {
            title: "Refresh only what changed",
            description:
              "Incremental scans update changed search documents instead of rebuilding the entire index, reducing work on large archives.",
          },
          {
            title: "Keep interaction responsive",
            description:
              "Cold session details load outside the main thread, and live project and session state stays consistent through reloads.",
          },
        ],
      },
      {
        version: "1.0.4",
        date: "2026-08-24",
        title: "Safer access and steadier large histories",
        summary:
          "This release adds a complete Japanese product site, protects loopback API access, preserves the last known-good scan during failures, and reduces indexing and rendering work across large archives.",
        direction:
          "Local-first privacy includes predictable access controls and durable recovery. Scale should not make either of them harder to understand.",
        highlights: [
          {
            title: "A complete Japanese product site",
            description:
              "Japanese-speaking visitors can now understand CodeSesh, its local data boundary, and its core workflow in their own language.",
          },
          {
            title: "Stronger local access controls",
            description:
              "Loopback API requests are authenticated, and trusted-proxy deployment now requires a safer host and HTTPS configuration.",
          },
          {
            title: "Last known-good state survives failures",
            description:
              "Interrupted scans, unavailable agents, and failed cache migrations no longer replace usable history with partial state.",
          },
        ],
      },
      {
        version: "1.0.3",
        date: "2026-08-16",
        title: "More accurate usage and more resilient recovery",
        summary:
          "Usage, tokens, and cost are now attributed to each message's time. Scan and cache failures remain visible instead of looking like empty history, while repeated parsing, queries, and rendering work has been removed.",
        direction:
          "CodeSesh treats correct history as the foundation. Performance work follows from preserving facts and avoiding work that does not need to happen twice.",
        highlights: [
          {
            title: "Usage follows message time",
            description:
              "Sessions spanning several days no longer assign all tokens and cost to a single day in the dashboard.",
          },
          {
            title: "Failures stay explicit",
            description:
              "Agent, scan, cache, and Web failures no longer silently appear as empty or successfully published state.",
          },
          {
            title: "Less repeated work",
            description:
              "Cached metadata, reused queries, and localized rendering reduce startup, search, and live-update overhead.",
          },
        ],
      },
    ],
  },
  zh: {
    meta: {
      title: "CodeSesh 更新日志 | 产品进展与方向",
      description:
        "阅读 CodeSesh 产品更新日志，了解每个版本改了什么、为什么重要，以及本地 AI 编码历史查看器在性能、安全和可靠性上的演进方向。",
    },
    navigation: "更新日志",
    hero: {
      title: "我们改了什么，也说明为什么",
      body: "CodeSesh 产品更新日志用面向用户的语言说明每个版本带来的变化、这些变化对本地 AI 编码历史有什么价值，以及推动这次更新的产品方向。",
    },
    latest: {
      label: "最新更新",
      title: "关注产品变化，而不是提交记录",
      body: "了解真正影响使用体验的改进，也了解我们据此继续建设 CodeSesh 的原则。",
      link: "阅读产品更新日志",
    },
    release: {
      historyLabel: "版本记录",
      changed: "本次更新",
      direction: "产品方向",
      details: "查看技术发布详情",
    },
    releases: [
      {
        version: "1.2.6",
        date: "2026-10-03",
        title: "更快补齐历史，看清重采集进度",
        summary:
          "CodeSesh 1.2.6 减少 Worker 采集和上传 AI 编码历史时的空等。重采集任务现在会说明触发原因，并显示可用的扫描计数，让耗时较长的恢复过程更容易跟进。",
        direction: "多机历史应减少不必要的等待，进度应对应已经保存和确认的工作。",
        highlights: [
          {
            title: "让历史采集与上传持续推进",
            description:
              "历史未扫完时继续扫描，上一条上传确认后立即处理下一条。失败请求仍会等待后重试，待上传内容持续保存在本地。",
          },
          {
            title: "知道重采集为何开始",
            description:
              "任务详情区分手动操作、Hub 数据恢复和 Worker 替换，自动触发的恢复也有清楚的原因。",
          },
          {
            title: "区分扫描进度与上传确认",
            description:
              "有可用上报时显示待完成 Agent 的来源项扫描计数，不将过期或离线上报当作当前进度。只有相关上传得到确认，任务才会完成。",
          },
        ],
      },
      {
        version: "1.2.5",
        date: "2026-10-03",
        title: "让中断恢复的 Worker 继续同步",
        summary:
          "CodeSesh 1.2.5 修复 Hub 在恢复过程中再次变更后，Worker 持续暂停同步的问题。Worker 会核实 Hub 身份、更新恢复状态，并继续上传排队的 AI 编码历史，解决此前重启仍无法恢复的情况。",
        direction:
          "多机器历史同步应能从中断中恢复，同时保留已经采集的内容，并确认数据发往正确的 Hub。",
        highlights: [
          {
            title: "从过期同步状态中恢复",
            description:
              "Hub 再次变更时，Worker 会更新恢复状态，避免反复尝试过期的恢复请求、在 Hub 中持续显示离线。",
          },
          {
            title: "保留排队历史并继续上传",
            description:
              "恢复时保留已排队的会话内容，即使来源日志已不再可用。先前恢复的确认响应丢失、Hub 随后再次变更时，也能继续恢复。",
          },
        ],
      },
      {
        version: "1.2.4",
        date: "2026-10-03",
        title: "找到命中消息，分段阅读长对话",
        summary:
          "CodeSesh 1.2.4 支持在连续中文文本中搜索词语，并从消息搜索结果直接定位到命中消息。长对话分批加载，来源机器更清楚，本地 AI 编码历史增多时，浏览与同步也能减少重复处理。",
        direction:
          "历史不断积累时，搜索和阅读仍应方便。按阅读需要加载内容，保留完整对话，并清楚标明来源。",
        highlights: [
          {
            title: "搜到中文词语，直接打开命中消息",
            description:
              "在较长的中文文本中找到短词，从消息搜索结果跳到首条命中消息。搜索会说明当前范围、时间范围和最多展示 50 个会话的限制，便于进一步筛选。",
          },
          {
            title: "无需先加载全部内容，就能开始阅读长对话",
            description:
              "接近底部时自动加载下一页，失败后可重试，也可选择加载全部消息，同时保留阅读位置。复制 Markdown 和查看收据仍会使用完整对话。",
          },
          {
            title: "确认会话来自哪台机器",
            description:
              "搜索结果标明来源机器，会话详情展示同步状态，并说明复制的恢复命令应在哪里运行，方便回到正确的工作环境。",
          },
          {
            title: "历史增多时减少重复处理",
            description:
              "复用未变消息和已有列表分页，统计仅读取所选会话的数据，并减少 Hub/Worker 同步过程中的临时内存占用。",
          },
        ],
      },
      {
        version: "1.2.3",
        date: "2026-10-01",
        title: "更清楚地回看对话、代码结果与问答",
        summary:
          "CodeSesh 1.2.3 通过清楚的表格、Code Mode 文本与图片、Codex 线程摘录和问题回答，改善本地 AI 编码历史回放。打开旧 Codex 对话也不再改变记录的活动时间。",
        direction: "会话回放应保留对话、工具结果与用户决策，最近活动应反映来源中记录的实际工作。",
        highlights: [
          {
            title: "回看 Codex 线程与已有回答",
            description:
              "查看线程读取结果中的用户消息和最终回复，按需展开更多轮次，并在异步问题旁查看记录的用户回答。",
          },
          {
            title: "查看 Code Mode 输出与源码",
            description:
              "DeepChat、Codex 和 Pi 的 Code Mode 按原顺序展示文本与图片。可展开并复制源码、查看失败详情，以及可用的 Pi 执行信息。",
          },
          {
            title: "表格易读，最近活动准确",
            description:
              "Agent 回复中的 Markdown 表格正常展示，宽表格在消息内滚动。Codex 设置等元数据不再将旧对话移入最近活动，下次扫描会修正已有时间记录。",
          },
        ],
      },
      {
        version: "1.2.2",
        date: "2026-10-01",
        title: "历史增多时，Dashboard 加载减少读取",
        summary:
          "CodeSesh 1.2.2 减少打开大型本地或 Hub 历史库的 Dashboard 和收藏时读取的数据，并完善加载诊断，便于排查仍然缓慢的页面。",
        direction:
          "AI 编码历史不断积累时，日常浏览应仅读取所需数据，加载问题也应有明确的排查依据。",
        highlights: [
          {
            title: "浏览已保存历史时减少读取",
            description:
              "Dashboard 查询通过索引读取会话摘要、用量和活动。收藏仅读取对应的会话，无需读取整个历史库。",
          },
          {
            title: "排查完整的页面加载过程",
            description:
              "加载日志在会话之外也覆盖项目、Dashboard 和收藏。慢查询日志记录各阶段耗时，便于定位本地服务或 Hub 的加载延迟。",
          },
        ],
      },
      {
        version: "1.2.1",
        date: "2026-09-29",
        title: "消息计数变化时，Worker 上传继续进行",
        summary:
          "CodeSesh 1.2.1 修复会话消息计数变化、可回放对话未变时的 Hub/Worker 同步失败。这类更新不再阻塞上传队列。",
        direction:
          "跨机器浏览 AI 编码历史需要可靠的同步：接受有效的会话更新，同时保留已经采集的对话内容。",
        highlights: [
          {
            title: "同步计数，不再阻塞上传",
            description:
              "Hub 现在接受纯元数据更新中的消息计数变化，包括 Codex 新增环境上下文或开发者指令、但未增加可回放消息的情况。",
          },
          {
            title: "保留已有对话内容",
            description: "Hub 保存最新计数时不重写已有消息和搜索内容，保留可用于回放和搜索的对话。",
          },
        ],
      },
      {
        version: "1.2.0",
        date: "2026-09-29",
        title: "在一个界面浏览多台机器的 AI 编码历史",
        summary:
          "CodeSesh 1.2.0 新增可选的自托管 Hub 与 Worker，将多台机器的本地 AI 编码历史汇总到同一个可搜索的 Web UI，同时保留各自的来源身份。",
        direction:
          "工作在不同机器间切换时，历史仍应便于检索。会话发送到哪里由使用者明确配置，采集问题也应清楚可查。",
        highlights: [
          {
            title: "汇总多台机器，按来源浏览",
            description:
              "将 Worker 与自己的 Hub 配对，按来源筛选会话。单机模式继续保留；Worker 会向你选择的 Hub 发送会话正文和元数据。",
          },
          {
            title: "查看采集问题并安排重采集",
            description:
              "查看队列和各 Agent 错误，按 Agent 范围排队重采集，并查阅任务历史。Worker 离线时仍可采集变化，恢复连接后再上传。",
          },
          {
            title: "替换 Worker，保留原有历史",
            description:
              "配对引导覆盖同机、局域网和公网 HTTPS 连接。更换 Worker 时保留归档历史、收藏、别名和项目分组。",
          },
          {
            title: "简化安装与本地数据管理",
            description:
              "新增 curl、Homebrew 和 Scoop 原生安装渠道。数据库、价格缓存和日志统一到 ~/.codesesh/，并引导旧目录迁移。",
          },
        ],
      },
      {
        version: "1.1.1",
        date: "2026-09-27",
        title: "看清会话费用，保存完整收据",
        summary:
          "CodeSesh 1.1.1 为会话收据增加模型和 Token 类别明细，支持将完整收据保存为 PNG。重新打开本地 AI 编码历史时，读取的缓存元数据也更少。",
        direction:
          "会话费用应当便于核对和保存，估算值与缺失明细应明确区分。浏览已保存的历史时，只加载当前视图需要的数据。",
        highlights: [
          {
            title: "查看模型与用量明细",
            description:
              "按模型和供应商查看用量及可用费用，区分未缓存输入、输出、缓存读取与缓存写入。估算费用有明确标记，缺失明细保留为未知。",
          },
          {
            title: "保存完整会话收据",
            description:
              "导出带有 CodeSesh 标识的 PNG，包含整张收据，即使明细超出抽屉可见区域也能完整保存。",
          },
          {
            title: "重新打开历史时减少读取",
            description: "会话列表从精简的展示元数据恢复，不再读取列表无需使用的定价明细。",
          },
        ],
      },
      {
        version: "1.1.0",
        date: "2026-09-26",
        title: "用原生程序浏览本地 AI 编码历史",
        summary:
          "CodeSesh 1.1.0 使用内嵌 Web UI 的原生后端。独立可执行文件无需 Node.js，模型价格在后台刷新，打开已保存的会话不必等待价格下载。",
        direction: "本地 AI 编码历史应该易于运行，打开已保存的工作不应依赖定价服务。",
        highlights: [
          {
            title: "选择独立程序或 npm 启动",
            description:
              "在受支持的 macOS、Linux 和 Windows 系统上使用原生可执行文件，也可以继续运行 npx codesesh。npm 启动器需要 Node.js 22 或更高版本。",
          },
          {
            title: "价格刷新不打断历史浏览",
            description: "模型价格在后台更新，费用估算使用缓存用量重新计算，无需重新读取会话文件。",
          },
          {
            title: "再次打开时复用已有工作",
            description:
              "通过缓存会话元数据、增量扫描和减少快照解码，降低启动时需要重复处理的工作量。",
          },
        ],
      },
      {
        version: "1.0.12",
        date: "2026-09-24",
        title: "升级到 OpenCode V2 后，继续查看会话历史",
        summary:
          "CodeSesh 现在支持基于 2.0.15 版本的 OpenCode V2 历史，同时保留 V1 支持。可以回看对话、思考与工具结果，避免重复计算 fork 复制的历史用量，并在切换数据库后刷新缓存历史。",
        direction:
          "本地 AI 编码工具改变存储格式后，历史记录仍应可查、可读，并保留对话上下文和数据源记录的用量。",
        highlights: [
          {
            title: "搜索与回放 OpenCode V2 会话",
            description:
              "查看已保存的消息、思考、工具结果、子会话与上下文压缩记录，也可以复制恢复命令，回到 OpenCode 继续会话。",
          },
          {
            title: "fork 与子任务用量不重复累计",
            description:
              "会话用量与费用采用 OpenCode 记录的累计值，避免再次计入 fork 复制的历史和子会话用量，明确记录的零费用也保持为零。",
          },
          {
            title: "历史记录跟随所选数据库",
            description:
              "支持选择自定义 OpenCode 数据库，并同步已保存的消息变化。切换数据库路径后，即使所选数据库早于上次扫描，也会重新读取并更新缓存会话。",
          },
        ],
      },
      {
        version: "1.0.11",
        date: "2026-09-21",
        title: "后台任务运行时也能正常退出",
        summary:
          "按 Ctrl+C 退出时，后台刷新和历史补扫现在会正常取消，不再显示误导性的失败信息。CodeSesh 保留已有会话视图，真正的错误仍会报告。",
        direction: "日常操作应有清楚的反馈，让本地 AI 编码历史中的错误提示对应需要处理的问题。",
        highlights: [
          {
            title: "停止后台刷新时不再出现错误堆栈",
            description:
              "在扫描会话或建立搜索索引时关闭 CodeSesh，不再将退出引起的取消误报为会话刷新失败。",
          },
          {
            title: "历史补扫采用一致的取消处理",
            description: "加载较早会话时退出也会正常取消任务，避免将预期的关闭记录为补扫失败。",
          },
        ],
      },
      {
        version: "1.0.10",
        date: "2026-09-21",
        title: "将 MiniMax Code 历史与其他会话一起浏览",
        summary:
          "CodeSesh 现在可以统一查看 MiniMax Code CLI 0.4.12 的本地 AI 编码历史，包含父子会话、思考、工具详情与用量。已保存的消息变化会持续同步，产品站移动端首屏插图也减少了纵向占用。",
        direction:
          "接入本地工具时，应保留其对话结构并反映已保存的变化，让用户能追溯工作过程，也能带着已有上下文继续会话。",
        highlights: [
          {
            title: "查看 MiniMax Code 会话与子任务",
            description:
              "浏览父子对话、查看思考、工具详情与用量，并复制恢复命令，在 MiniMax Code 中继续原有会话。",
          },
          {
            title: "同步已保存的历史变化",
            description:
              "自动刷新会识别 MiniMax Code 的新增消息、修改和删除，目录监听遗漏的写入也能被检测。",
          },
          {
            title: "移动端为内容留出更多空间",
            description: "产品站首屏插图在移动端更矮，为页面内容留出更多可见空间。",
          },
        ],
      },
      {
        version: "1.0.9",
        date: "2026-09-19",
        title: "在同一界面查看 DeepChat 与 Cherry Studio 历史",
        summary:
          "CodeSesh 现在可以将 DeepChat、Cherry Studio 对话与其他本地 AI 编码历史一起浏览。会话布局更易阅读，小额费用清晰可见，Claude Code 刷新时也会移除已停用数据目录中的缓存记录。",
        direction:
          "支持更多本地工具时，应保留各来源的对话结构与用量记录，并清楚说明哪些历史可以查找和回放。",
        highlights: [
          {
            title: "统一浏览 DeepChat 与编码会话",
            description:
              "读取 DeepChat 新版未加密本地数据库中的原生及 ACP 会话，回放消息、查看用量，并随记录变化更新。",
          },
          {
            title: "支持 Cherry Studio Agent 与助手聊天",
            description:
              "查看 Cherry Studio 2.x 的 Agent 会话及其工作目录，按当前选中的分支阅读普通助手聊天，并统计该分支的用量。",
          },
          {
            title: "看清日期、消息与小额费用",
            description:
              "日期分隔与适应较窄屏幕的布局让长对话更易阅读。不足一美分的正数费用显示为 <$0.01，不再显示为 $0.00。",
          },
          {
            title: "查找本地历史的指南",
            description:
              "英文、中文、日文指南说明 Claude Code 与 Codex 记录的位置、搜索和回放方法，以及会话缺失时的排查步骤。",
          },
        ],
      },
      {
        version: "1.0.8",
        date: "2026-09-13",
        title: "看清各模型的 Token 用量占比",
        summary:
          "概览与项目 Dashboard 现在展示所选日期范围内各模型的 Token 总量与占比，包含缓存 Token。导航悬停反馈更加一致，产品站也更新了天体视觉与资源加载方式。",
        direction: "本地 AI 编码历史应让用量对比易于理解，并让每项细分统计遵循用户选择的时间范围。",
        highlights: [
          {
            title: "按模型比较 Token 用量",
            description:
              "在概览与项目 Dashboard 中比较各模型的 Token 总量和百分比，通过指针或键盘查看详情。",
          },
          {
            title: "统计遵循所选日期",
            description: "模型用量与 Dashboard 日期范围保持一致，范围外的会话活动不再计入比较。",
          },
          {
            title: "一致的导航反馈与更轻的加载",
            description:
              "导航使用统一悬停反馈，Agent 介绍页按需加载，产品站资源使用缓存并预加载首页主视觉。",
          },
        ],
      },
      {
        version: "1.0.7",
        date: "2026-09-08",
        title: "活跃时段概览与更稳健的实时同步",
        summary:
          "Overview 概览面板新增活跃时段分布，直观呈现全天不同时段的 AI 交互节奏。实时更新大幅加固断线重连与异常自愈能力，临时不可用的会话详情支持一键重试，自定义会话别名在实时流中得到完整保护。",
        direction:
          "本地编码历史工具不仅要忠实记录会话，更要帮助开发者洞察自己的 AI 协作节奏；而无论本地环境或连接如何波动，实时同步都必须始终稳定自愈。",
        highlights: [
          {
            title: "一日活跃时段分布",
            description:
              "按上午、下午、晚间等时段清晰汇总与 Agent 的交互频次，配合直观的气泡强度图例呈现工作节奏。",
          },
          {
            title: "自愈式实时状态同步",
            description:
              "网络重连或偶发更新异常后自动完成状态恢复，重叠更新后及时刷新统计指标，无需手动刷新页面。",
          },
          {
            title: "会话按需重试与别名保护",
            description:
              "临时读取失败的会话详情可直接重试恢复，自定义设置的会话别名在实时更新推送期间不会被覆盖或丢失。",
          },
        ],
      },
      {
        version: "1.0.6",
        date: "2026-09-05",
        title: "多语言界面与更快的历史分析",
        summary:
          "CodeSesh 正式支持简体中文、英文与日文三语界面并持久化偏好设置。模型定价现已接入 models.dev 自动同步最新标准，全量历史分析与会话层级浏览速度显著提升。",
        direction:
          "本地历史查看器应当以你最熟悉的母语呈现，并在数月高频使用、积累海量 Agent 会话后，依然保持即时响应与准确透明。",
        highlights: [
          {
            title: "原生三语界面支持",
            description:
              "支持在简体中文、英文和日文间自由切换并记住偏好，会话对话原文与代码片段始终保持原始语言。",
          },
          {
            title: "实时同步模型定价",
            description:
              "扫描前自动从 models.dev 获取并缓存最新定价数据，让日益丰富的 Agent 模型用量与花费估算更准更全。",
          },
          {
            title: "全历史分析显著加速",
            description:
              "通过消息用量索引与层级遍历优化，大幅加快 Dashboard 指标加载，大型历史库浏览更流畅。",
          },
        ],
      },
      {
        version: "1.0.5",
        date: "2026-08-31",
        title: "刷新更快，实时状态更可信",
        summary:
          "大型历史库刷新时只更新发生变化的搜索文档，冷会话详情交给后台 Worker 加载。现在也可以从操作菜单把任意会话复制为结构清晰的 Markdown。",
        direction:
          "随着本地历史持续增长，CodeSesh 仍应保持即时响应；扫描进度、会话内容和项目状态也必须始终清楚可信。",
        highlights: [
          {
            title: "复制会话为 Markdown",
            description: "完整对话可以直接带到文档、issue 或其他工具，无需手工重新整理消息结构。",
          },
          {
            title: "只刷新发生变化的内容",
            description: "增量扫描不再重建整份搜索索引，大型历史库的刷新工作量显著减少。",
          },
          {
            title: "保持交互响应",
            description: "冷会话详情移出主线程加载，重新加载期间的会话与项目实时状态也能保持一致。",
          },
        ],
      },
      {
        version: "1.0.4",
        date: "2026-08-24",
        title: "访问更安全，大型历史更稳定",
        summary:
          "本次更新带来完整的日语产品站、受保护的环回 API 访问、失败时保留的最近一次可用扫描结果，并减少大型历史库中的索引与渲染工作。",
        direction:
          "本地优先不仅意味着数据留在设备上，也意味着访问边界明确、失败后可以可靠恢复，而且这些能力不应随数据规模增长而变得难以理解。",
        highlights: [
          {
            title: "完整的日语产品站",
            description: "日语用户可以用自己的语言了解 CodeSesh、本地数据边界与核心使用流程。",
          },
          {
            title: "更严格的本地访问控制",
            description:
              "环回 API 请求需要认证，可信代理部署也必须使用更安全的 host 与 HTTPS 配置。",
          },
          {
            title: "失败时保留可用状态",
            description:
              "扫描中断、Agent 不可用或缓存迁移失败时，不再用不完整状态覆盖已有的可用历史。",
          },
        ],
      },
      {
        version: "1.0.3",
        date: "2026-08-16",
        title: "用量更准确，失败恢复更可靠",
        summary:
          "用量、Token 与成本现在按每条消息发生的时间归属。扫描与缓存失败会被明确呈现，不再看起来像空历史，同时减少了重复解析、查询与渲染。",
        direction:
          "CodeSesh 首先保证历史事实正确，再通过保留事实和消除不必要的重复工作来获得性能。",
        highlights: [
          {
            title: "用量跟随消息时间",
            description: "跨越多天的会话不再把所有 Token 与成本集中计算到某一天。",
          },
          {
            title: "失败保持明确",
            description: "Agent、扫描、缓存与 Web 加载失败不再被伪装成空数据或成功发布。",
          },
          {
            title: "减少重复工作",
            description: "通过缓存元数据、复用查询和局部渲染，降低启动、搜索与实时更新开销。",
          },
        ],
      },
    ],
  },
  ja: {
    meta: {
      title: "CodeSesh 更新履歴 | 製品アップデートと方向性",
      description:
        "CodeSesh の更新履歴で、各リリースの変更点とその意味、ローカル AI コーディング履歴ビューアーの性能、安全性、信頼性に関する方向性を確認できます。",
    },
    navigation: "更新履歴",
    hero: {
      title: "変更点と、その理由を伝える",
      body: "CodeSesh の製品更新履歴では、各リリースの変更点、ローカル AI コーディング履歴にもたらす価値、開発の背景にある製品の方向性を利用者向けの言葉で説明します。",
    },
    latest: {
      label: "最新アップデート",
      title: "コミットではなく、製品の変化を追う",
      body: "日々の使い心地を変える改善と、次の CodeSesh を形作るための原則を紹介します。",
      link: "製品更新履歴を読む",
    },
    release: {
      historyLabel: "リリース履歴",
      changed: "主な変更点",
      direction: "製品の方向性",
      details: "技術的なリリース詳細を見る",
    },
    releases: [
      {
        version: "1.2.6",
        date: "2026-10-03",
        title: "履歴の収集を速め、再収集の進捗をわかりやすく",
        summary:
          "CodeSesh 1.2.6 は、Worker が AI コーディング履歴を収集・アップロードする際の不要な待ち時間を減らします。再収集タスクに開始理由と取得できたスキャン件数を表示し、長い復旧処理の進み具合を確認しやすくしました。",
        direction:
          "複数マシンの履歴を不要な待ち時間なく集約し、保存済みの処理と確認済みのアップロードに基づいて進捗を伝えます。",
        highlights: [
          {
            title: "履歴の収集とアップロードを続けて処理",
            description:
              "未収集の履歴がある間はスキャンを続け、アップロードの確認が届いたら次の送信に進みます。失敗時は待ってから再試行し、送信待ちの内容はローカルに保持します。",
          },
          {
            title: "再収集が始まった理由を確認",
            description:
              "手動操作、Hub のデータ復旧、Worker の置き換えをタスク詳細で区別します。自動的に始まった復旧処理も理由がわかります。",
          },
          {
            title: "スキャンとアップロード確認を区別",
            description:
              "報告がある場合は、未完了の Agent がスキャンしたソース項目数を表示します。古い報告やオフライン時の値を現在の進捗として扱わず、対象のアップロードが確認されてからタスクを完了します。",
          },
        ],
      },
      {
        version: "1.2.5",
        date: "2026-10-03",
        title: "復旧が中断した Worker の同期を再開",
        summary:
          "CodeSesh 1.2.5 は、復旧中に Hub の状態が再び変わると Worker の同期が停止したままになる問題を修正します。接続先の Hub を確認して復旧状態を更新し、キューに保存した AI コーディング履歴のアップロードを再開します。Worker を再起動しても解消しなかったケースに対応します。",
        direction:
          "複数マシンの履歴同期は、中断から復旧できることが必要です。収集済みの内容を保持し、送信先の Hub を確認しながら同期を再開します。",
        highlights: [
          {
            title: "古い同期状態から復旧",
            description:
              "Hub の状態が再び変わったときに Worker の復旧状態を更新します。古い復旧要求を繰り返して Hub 上でオフラインのままになる問題を解消します。",
          },
          {
            title: "キュー内の履歴を保持してアップロード",
            description:
              "元のログが利用できなくなっていても、キューに保存済みの会話内容を保持します。復旧の確認応答が失われた後に Hub の状態が再び変わった場合も復旧を続けられます。",
          },
        ],
      },
      {
        version: "1.2.4",
        date: "2026-10-03",
        title: "一致したメッセージを見つけ、長い会話を少しずつ読む",
        summary:
          "CodeSesh 1.2.4では、続けて書かれた中国語の中から語句を検索でき、メッセージの検索結果から一致した箇所を開けます。長い会話をページ単位で読み込み、ソースのマシンを明示するとともに、履歴の増加に伴う閲覧や同期の重複処理を減らしました。",
        direction:
          "履歴が増えても検索と閲覧を使いやすく保つため、読むために必要な内容から読み込み、会話全体を保持し、そのソースを明確にします。",
        highlights: [
          {
            title: "中国語の語句を検索し、一致したメッセージを開く",
            description:
              "長い中国語の文章に含まれる短い語句を検索し、メッセージの検索結果から最初に一致した箇所へ移動できます。検索対象、期間、最大50セッションの表示上限も確認でき、結果を絞り込みやすくなります。",
          },
          {
            title: "すべての読み込みを待たずに長い会話を読む",
            description:
              "末尾に近づくと次のページを読み込みます。失敗したページの再試行や全メッセージの読み込みも選べ、読んでいる位置を保ちます。Markdownのコピーとレシートには会話全体を使います。",
          },
          {
            title: "セッションがどのマシンのものかを確認",
            description:
              "検索結果にソースのマシンを表示します。セッションの詳細では同期状態と、コピーした再開コマンドを実行する場所を確認でき、元の作業環境に戻りやすくなります。",
          },
          {
            title: "履歴が増えても重複処理を抑える",
            description:
              "変更のないメッセージや保持済みの一覧ページを再利用し、統計の読み取りを選択したセッションに絞ります。Hub/Worker同期中の一時的なメモリ使用量も減らしました。",
          },
        ],
      },
      {
        version: "1.2.3",
        date: "2026-10-01",
        title: "会話、コードの実行結果、回答を読みやすく",
        summary:
          "CodeSesh 1.2.3では、表の表示、Code Modeのテキストと画像、Codexのスレッド抜粋と質問への回答を改善し、ローカルAIコーディング履歴を確認しやすくしました。古いCodexチャットを開いても、記録された活動時刻は変わりません。",
        direction:
          "履歴の再生では会話、ツールの結果、ユーザーの判断を保持し、最近のアクティビティはソースに記録された作業を反映することを重視しています。",
        highlights: [
          {
            title: "Codexのスレッドと記録済みの回答を確認",
            description:
              "スレッド取得結果のユーザーメッセージと最終回答を読み、必要に応じて会話の続きを展開できます。非同期の質問には、記録されたユーザーの回答も表示されます。",
          },
          {
            title: "Code Modeの出力とソースを確認",
            description:
              "DeepChat、Codex、PiのCode Modeでは、テキストと画像を元の順序で表示します。ソースの展開とコピー、失敗の詳細、記録されているPiの実行情報を確認できます。",
          },
          {
            title: "読みやすい表と正確な活動時刻",
            description:
              "Agentの回答に含まれるMarkdownの表を表示し、横長の表はメッセージ内でスクロールできます。Codexの設定などのメタデータで古いチャットが最近のアクティビティに移ることはなく、次のスキャンで保存済みの時刻も修正されます。",
          },
        ],
      },
      {
        version: "1.2.2",
        date: "2026-10-01",
        title: "履歴が増えても、ダッシュボードの読み取りを抑える",
        summary:
          "CodeSesh 1.2.2では、大きなローカル履歴やHubの履歴でダッシュボードとブックマークを開く際のデータ読み取りを減らしました。読み込みの診断情報も充実し、遅いページの原因を調べやすくなります。",
        direction:
          "AIコーディング履歴が増えても、日常の閲覧では必要なデータだけを読み取り、読み込みの問題を追跡できることを重視しています。",
        highlights: [
          {
            title: "保存した履歴の読み取りを削減",
            description:
              "ダッシュボードはインデックスからセッション概要、使用量、アクティビティを読み取ります。ブックマークは対象のセッションだけを取得し、履歴全体を読み取りません。",
          },
          {
            title: "ページ全体の読み込みを診断",
            description:
              "読み込みログはセッションに加え、プロジェクト、ダッシュボード、ブックマークも対象にします。遅いクエリの段階別の所要時間から、ローカルサーバーやHubの遅延を調べられます。",
          },
        ],
      },
      {
        version: "1.2.1",
        date: "2026-09-29",
        title: "メッセージ数が変わってもWorkerのアップロードを継続",
        summary:
          "CodeSesh 1.2.1では、再生できる会話が変わらずメッセージ数だけが変化した場合のHub/Worker同期エラーを修正しました。この更新でアップロードキューが止まることはなくなります。",
        direction:
          "複数のマシンのAIコーディング履歴を確実に参照できるよう、有効な更新を受け入れながら、収集済みの会話を保持します。",
        highlights: [
          {
            title: "メッセージ数の更新で同期を止めない",
            description:
              "Hubがメタデータのみの更新でもメッセージ数の変更を受け入れるようになりました。Codexで環境コンテキストや開発者指示が追加され、再生対象のメッセージが増えない場合も同期できます。",
          },
          {
            title: "保存済みの会話を維持",
            description:
              "Hubは既存のメッセージや検索内容を書き換えずに最新の件数を保存し、再生や検索に使う会話を保持します。",
          },
        ],
      },
      {
        version: "1.2.0",
        date: "2026-09-29",
        title: "複数のマシンのAIコーディング履歴を一か所で確認",
        summary:
          "CodeSesh 1.2.0では、任意で利用できるセルフホストのHubとWorkerを追加しました。複数のマシンのローカル履歴を、取得元を区別したまま一つのWeb UIで検索できます。",
        direction:
          "作業するマシンが変わっても、履歴を検索できることを重視しています。セッションの送信先は利用者が設定し、収集の問題も確認できるようにします。",
        highlights: [
          {
            title: "複数のマシンの履歴をまとめて表示",
            description:
              "Workerを自分のHubとペアリングし、取得元でセッションを絞り込めます。単体モードも引き続き利用可能です。Workerは選択したHubへセッション本文とメタデータを送信します。",
          },
          {
            title: "収集状況を確認し、再収集を依頼",
            description:
              "キューやAgentごとのエラーを確認し、対象Agentを指定して再収集を予約できます。タスク履歴も確認でき、オフライン中の変更は再接続後にアップロードされます。",
          },
          {
            title: "履歴を引き継いでWorkerを交換",
            description:
              "同一マシン、LAN、公開HTTPS接続のペアリングを案内します。Workerを交換しても、保存済み履歴、ブックマーク、別名、プロジェクトグループを維持できます。",
          },
          {
            title: "インストールとデータ管理を簡単に",
            description:
              "curl、Homebrew、Scoopによるネイティブ版のインストールに対応しました。データベース、価格キャッシュ、ログを ~/.codesesh/ にまとめ、旧ディレクトリからの移行を案内します。",
          },
        ],
      },
      {
        version: "1.1.1",
        date: "2026-09-27",
        title: "セッションの費用を確認し、レシート全体を保存",
        summary:
          "CodeSesh 1.1.1 では、セッションのレシートにモデル別・トークン種別の内訳が加わり、全体を PNG として保存できるようになりました。ローカルの AI コーディング履歴を開き直す際に読み込むキャッシュのメタデータも削減しました。",
        direction:
          "セッションの費用は確認しやすく、保存しやすい形で示し、推定値と不明な内訳を明確に区別します。保存済みの履歴を閲覧するときは、その表示に必要なデータだけを読み込みます。",
        highlights: [
          {
            title: "モデルと用途ごとに使用量を確認",
            description:
              "モデルとプロバイダーごとに、非キャッシュ入力、出力、キャッシュ読み取り・書き込みの使用量と取得可能な費用を確認できます。推定費用にはラベルを付け、不明な内訳をゼロとして表示しません。",
          },
          {
            title: "レシート全体を保存",
            description:
              "CodeSesh のロゴ入り PNG としてレシート全体を書き出せます。ドロワーの表示範囲を超える長い明細も含まれます。",
          },
          {
            title: "履歴を開くときの読み込みを削減",
            description:
              "セッション一覧は表示用の小さなメタデータから復元し、一覧に不要な料金計算の詳細を読み込まなくなりました。",
          },
        ],
      },
      {
        version: "1.1.0",
        date: "2026-09-26",
        title: "ネイティブアプリでローカルのAIコーディング履歴を閲覧",
        summary:
          "CodeSesh 1.1.0は、Web UIを内蔵したネイティブバックエンドを採用しました。単体の実行ファイルにはNode.jsが不要です。モデル料金はバックグラウンドで更新されるため、料金のダウンロードを待たずに保存済みのセッションを開けます。",
        direction:
          "ローカルのAIコーディング履歴は手軽に閲覧できるべきです。保存済みの作業を開くために、料金サービスの応答を待つ必要はありません。",
        highlights: [
          {
            title: "単体の実行ファイルでもnpmでも起動",
            description:
              "対応するmacOS、Linux、Windowsでネイティブ実行ファイルを使うか、引き続きnpx codeseshで起動できます。npmランチャーにはNode.js 22以降が必要です。",
          },
          {
            title: "料金の更新中も履歴を閲覧",
            description:
              "モデル料金をバックグラウンドで更新します。推定費用はキャッシュ済みの使用量から再計算するため、会話ファイルの再読み込みは不要です。",
          },
          {
            title: "再起動時に処理済みの情報を活用",
            description:
              "セッションのメタデータキャッシュと差分スキャンを活用し、スナップショットのデコード処理を減らすことで、起動時の重複処理を抑えます。",
          },
        ],
      },
      {
        version: "1.0.12",
        date: "2026-09-24",
        title: "OpenCode V2 への移行後も会話履歴を確認",
        summary:
          "CodeSesh が OpenCode 2.0.15 に基づく V2 の履歴に対応しました。V1 への対応も維持しています。会話、思考内容、ツールの結果を確認でき、フォークでコピーされた履歴の使用量を二重計上しません。データベースを切り替えると、キャッシュされた履歴も更新します。",
        direction:
          "ローカル AI コーディングツールの保存形式が変わっても、履歴を検索して読み返せることを重視しています。会話の文脈と、各データソースが記録した使用量を保ちます。",
        highlights: [
          {
            title: "OpenCode V2 の会話を検索して振り返る",
            description:
              "保存されたメッセージ、思考内容、ツールの結果、子セッション、コンテキスト圧縮の記録を確認できます。再開コマンドをコピーして OpenCode で会話を続けることもできます。",
          },
          {
            title: "フォークや子タスクの使用量を二重計上しない",
            description:
              "使用量と費用には OpenCode が記録したセッション合計を使い、フォークでコピーされた履歴や子セッションの使用量を重ねて加算しません。明示的にゼロと記録された費用もそのまま表示します。",
          },
          {
            title: "選択したデータベースに履歴を合わせる",
            description:
              "OpenCode のデータベースを指定し、保存されたメッセージの変更を反映できます。データベースのパスを切り替えると、選択したデータベースが前回のスキャンより古い場合も、キャッシュされたセッションを更新します。",
          },
        ],
      },
      {
        version: "1.0.11",
        date: "2026-09-21",
        title: "バックグラウンド処理中も正常に終了",
        summary:
          "Ctrl+C で終了するとき、バックグラウンド更新や過去の履歴の読み込みを中止しても、誤解を招く失敗メッセージが表示されなくなりました。既存のセッション表示を保ち、実際のエラーは引き続き報告します。",
        direction:
          "日常的な操作には明確なフィードバックが必要です。ローカル AI コーディング履歴のエラー表示は、対処が必要な問題を伝えるものにします。",
        highlights: [
          {
            title: "バックグラウンド更新をエラースタックなしで停止",
            description:
              "セッションのスキャンや検索索引の作成中に CodeSesh を閉じても、終了に伴うキャンセルを更新失敗として表示しなくなりました。",
          },
          {
            title: "過去の履歴の読み込みも同じように中止",
            description:
              "古いセッションの読み込み中も同じキャンセル処理を使い、通常の終了が履歴の読み込み失敗として記録されることを防ぎます。",
          },
        ],
      },
      {
        version: "1.0.10",
        date: "2026-09-21",
        title: "MiniMax Code の履歴をほかのセッションとまとめて閲覧",
        summary:
          "MiniMax Code CLI 0.4.12 の履歴を、ほかのローカル AI コーディング履歴と一緒に確認できるようになりました。親子セッション、思考内容、ツールの詳細、使用量を表示し、保存済みメッセージの変更も反映します。製品サイトではモバイル表示の冒頭画像を低くしました。",
        direction:
          "ローカルツールへの対応では、会話の構造を保ち、保存された変更を反映することを重視しています。作業の経緯をたどり、これまでの文脈を引き継いでセッションを再開できるようにします。",
        highlights: [
          {
            title: "MiniMax Code のセッションとサブタスクを確認",
            description:
              "親子の会話を閲覧し、思考内容、ツールの詳細、使用量を確認できます。再開コマンドをコピーすれば、MiniMax Code で元のセッションを続けられます。",
          },
          {
            title: "保存済みの履歴を最新に保つ",
            description:
              "MiniMax Code の新規メッセージ、編集、削除を自動更新で反映します。ディレクトリ監視で見逃す書き込みも検出します。",
          },
          {
            title: "モバイル画面でコンテンツの表示領域を確保",
            description:
              "製品サイトの冒頭画像をモバイル画面では低くし、ページの内容を表示するための空間を増やしました。",
          },
        ],
      },
      {
        version: "1.0.9",
        date: "2026-09-19",
        title: "DeepChat と Cherry Studio の履歴をひとつの画面で",
        summary:
          "DeepChat と Cherry Studio の会話を、ほかのローカル AI コーディング履歴と一緒に閲覧できるようになりました。セッションの読みやすさと少額費用の表示を改善し、Claude Code の更新時には使わなくなったデータディレクトリのキャッシュ記録を除外します。",
        direction:
          "対応するローカルツールを増やす際も、各ツールの会話構造と使用量の記録を保ち、どの履歴を検索・再生できるかを明確に伝えることを重視しています。",
        highlights: [
          {
            title: "DeepChat の会話もまとめて閲覧",
            description:
              "DeepChat の現行の暗号化されていないローカルデータベースから、ネイティブおよび ACP セッションを読み取ります。メッセージの再生や使用量の確認ができ、記録の変更も反映されます。",
          },
          {
            title: "Cherry Studio の Agent とアシスタントチャットに対応",
            description:
              "Cherry Studio 2.x の Agent セッションをワークスペースとともに確認できます。アシスタントチャットは選択中の分岐を表示し、その分岐に沿って使用量を集計します。",
          },
          {
            title: "日付、メッセージ、少額費用を読み取りやすく",
            description:
              "日付の区切りと狭い画面に対応したレイアウトで、長い会話を追いやすくしました。1 セント未満の正の費用は $0.00 ではなく <$0.01 と表示します。",
          },
          {
            title: "ローカル履歴を探すためのガイド",
            description:
              "英語、中国語、日本語のガイドで、Claude Code と Codex の記録場所、検索と再生の方法、セッションが見つからない場合の確認手順を説明しています。",
          },
        ],
      },
      {
        version: "1.0.8",
        date: "2026-09-13",
        title: "モデルごとのトークン使用割合を把握",
        summary:
          "概要とプロジェクトのダッシュボードで、選択した期間のモデル別トークン数と割合を確認できるようになりました。キャッシュトークンも含まれます。ナビゲーションのホバー表示を統一し、製品サイトの天体ビジュアルとリソース読み込みも更新しました。",
        direction:
          "ローカルの AI コーディング履歴では、使用量を比較しやすくし、すべての内訳を選択した期間に揃えることを重視しています。",
        highlights: [
          {
            title: "モデル別のトークン使用割合",
            description:
              "概要とプロジェクトのダッシュボードでモデル別のトークン数と割合を比較でき、ポインターやキーボードで詳細を確認できます。",
          },
          {
            title: "選択期間に沿った集計",
            description:
              "モデル使用量がダッシュボードの日付範囲に揃い、期間外のセッション内の使用量が比較に含まれなくなりました。",
          },
          {
            title: "統一された操作感と読み込みの改善",
            description:
              "ナビゲーションのホバー表示を統一しました。Agent 紹介ページは必要時に読み込み、製品サイトではリソースのキャッシュとトップ画像の先読みを利用します。",
          },
        ],
      },
      {
        version: "1.0.7",
        date: "2026-09-08",
        title: "アクティブ時間帯の可視化とリアルタイム同期の堅牢化",
        summary:
          "ダッシュボードにアクティブ時間帯の分布表示が加わり、1 日のどの時間帯に AI と対話しているかがひと目で把握できるようになりました。ネットワーク再接続や一時的なエラーからの自動復旧を強化し、セッション詳細の再試行やカスタム別名の保護も向上しています。",
        direction:
          "ローカルの履歴ツールは開発の記録を保つだけでなく、日々の作業リズムを直感的に捉えられるべきです。そして接続の変動があっても、リアルタイム同期は常に自律して正常な状態を維持しなければなりません。",
        highlights: [
          {
            title: "時間帯別のアクティブ状況",
            description:
              "朝、昼、夜などの時間区分ごとに Agent との対話頻度をまとめ、バブルの濃淡で作業リズムを直感的に示します。",
          },
          {
            title: "自律復旧するリアルタイム同期",
            description:
              "接続切断や一時的なストリーム障害の後も自動で状態を復元し、重複した更新の後も統計値を正しく再計算します。",
          },
          {
            title: "セッションの再試行と別名保護",
            description:
              "一時的に読み込めなかったセッション詳細はその場で再試行でき、設定したカスタム別名がリアルタイム更新で消えるのを防ぎます。",
          },
        ],
      },
      {
        version: "1.0.6",
        date: "2026-09-05",
        title: "多言語 UI と高速化された履歴分析",
        summary:
          "CodeSesh が日本語、英語、簡体字中国語の 3 言語 UI に対応し、言語設定を保存できるようになりました。models.dev から最新のモデル価格を自動取得してコスト試算の精度を高め、全期間の履歴分析と階層表示も大幅に高速化しています。",
        direction:
          "ローカル履歴ビューアーは使い慣れた言語で自然に操作でき、長期間にわたる膨大な Agent 会話が蓄積されても素早く軽快に動作し続けるべきだと考えています。",
        highlights: [
          {
            title: "ネイティブな 3 言語対応",
            description:
              "日本語、英語、簡体字中国語を自由に切り替えられ、設定を保持します。会話の原文やコードはそのまま維持されます。",
          },
          {
            title: "モデル価格の自動更新",
            description:
              "スキャン前に models.dev から最新の価格情報を自動キャッシュし、多様化するモデルの利用コストをより正確に把握できます。",
          },
          {
            title: "全期間の分析を高速化",
            description:
              "メッセージ使用量へのインデックス追加と階層巡回の最適化により、ダッシュボードの表示や大規模な履歴の閲覧がさらに軽快になりました。",
          },
        ],
      },
      {
        version: "1.0.5",
        date: "2026-08-31",
        title: "更新を高速化し、ライブ状態の信頼性を向上",
        summary:
          "大規模な履歴では、変更された検索ドキュメントだけを更新するようになりました。未読み込みのセッション詳細はバックグラウンド Worker で処理され、任意のセッションを操作メニューから Markdown としてコピーできます。",
        direction:
          "ローカル履歴が増えても CodeSesh は素早く応答し、スキャンやセッションの現在の状態を常に信頼できる製品であるべきだと考えています。",
        highlights: [
          {
            title: "セッションを Markdown としてコピー",
            description:
              "会話の構造を手作業で整え直さずに、ドキュメント、issue、ほかのツールへ移せます。",
          },
          {
            title: "変更された内容だけを更新",
            description:
              "増分スキャンで検索索引全体を再構築せず、大規模な履歴の更新作業を減らします。",
          },
          {
            title: "操作中の応答性を維持",
            description:
              "セッション詳細をメインスレッド外で読み込み、再読み込み中もプロジェクトとセッションの状態を一貫させます。",
          },
        ],
      },
      {
        version: "1.0.4",
        date: "2026-08-24",
        title: "より安全なアクセスと、安定した大規模履歴",
        summary:
          "日本語の製品サイトを追加し、ループバック API へのアクセスを保護しました。障害時も最後に正常だったスキャンを維持し、大規模な履歴に対する索引作成と描画の処理量を減らしています。",
        direction:
          "ローカル優先には、予測可能なアクセス制御と確実な復旧も含まれます。データが増えても、どちらも分かりやすく保つことを重視します。",
        highlights: [
          {
            title: "日本語の製品サイト",
            description:
              "CodeSesh の目的、ローカルデータの境界、基本的な使い方を日本語で確認できます。",
          },
          {
            title: "ローカルアクセス制御を強化",
            description:
              "ループバック API を認証し、信頼済みプロキシには安全な host と HTTPS の設定を必須にしました。",
          },
          {
            title: "障害時も正常な状態を維持",
            description:
              "スキャンの中断、Agent の停止、キャッシュ移行の失敗が、利用可能な履歴を不完全な状態で上書きしません。",
          },
        ],
      },
      {
        version: "1.0.3",
        date: "2026-08-16",
        title: "より正確な使用量と、確実な復旧",
        summary:
          "使用量、Token、コストを各メッセージの時刻に基づいて集計するようになりました。スキャンやキャッシュの障害を空の履歴に見せず、重複する解析、問い合わせ、描画も削減しています。",
        direction:
          "CodeSesh は履歴の正確さを土台にします。事実を守り、同じ処理を繰り返さないことが性能改善につながると考えています。",
        highlights: [
          {
            title: "使用量をメッセージ時刻に集計",
            description:
              "複数日にわたるセッションの Token とコストが、特定の 1 日だけにまとめて計上されなくなりました。",
          },
          {
            title: "障害を明確に表示",
            description:
              "Agent、スキャン、キャッシュ、Web の障害を、空データや正常な公開状態として扱いません。",
          },
          {
            title: "重複処理を削減",
            description:
              "メタデータのキャッシュ、問い合わせの再利用、局所的な描画により、起動、検索、ライブ更新の負荷を減らします。",
          },
        ],
      },
    ],
  },
} satisfies Record<Locale, ChangelogCopy>;

export function formatReleaseDate(locale: Locale, date: string): string {
  return new Intl.DateTimeFormat(localeConfig[locale].language, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function createChangelogPageConfig(locale: Locale) {
  const t = changelogCopy[locale];
  const canonicalUrl = new URL(changelogRoutes[locale], siteUrl).toString();
  const webpageId = `${canonicalUrl}#webpage`;
  const blogId = `${canonicalUrl}#updates`;
  const organizationId = `${siteUrl}/#organization`;
  const softwareId = `${siteUrl}/#software`;

  return {
    title: t.meta.title,
    description: t.meta.description,
    route: changelogRoutes[locale],
    alternateRoutes: changelogRoutes,
    schema: [
      {
        "@type": "SoftwareApplication",
        "@id": softwareId,
        name: "CodeSesh",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Windows, macOS, Linux",
        url: new URL(localeConfig[locale].route, siteUrl).toString(),
        codeRepository: "https://github.com/xingkaixin/codesesh",
        isAccessibleForFree: true,
        publisher: { "@id": organizationId },
      },
      {
        "@type": "CollectionPage",
        "@id": webpageId,
        url: canonicalUrl,
        name: t.meta.title,
        description: t.meta.description,
        inLanguage: localeConfig[locale].language,
        isPartOf: { "@id": `${siteUrl}/#website` },
        about: { "@id": softwareId },
        mainEntity: { "@id": blogId },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${canonicalUrl}#breadcrumb`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "CodeSesh",
            item: new URL(localeConfig[locale].route, siteUrl).toString(),
          },
          {
            "@type": "ListItem",
            position: 2,
            name: t.navigation,
            item: canonicalUrl,
          },
        ],
      },
      {
        "@type": "Blog",
        "@id": blogId,
        name: t.meta.title,
        description: t.meta.description,
        url: canonicalUrl,
        inLanguage: localeConfig[locale].language,
        publisher: { "@id": organizationId },
        blogPost: t.releases.map((release) => ({
          "@type": "BlogPosting",
          "@id": `${canonicalUrl}#v${release.version.replaceAll(".", "-")}`,
          headline: `CodeSesh ${release.version}: ${release.title}`,
          description: release.summary,
          datePublished: release.date,
          dateModified: release.date,
          inLanguage: localeConfig[locale].language,
          author: { "@id": organizationId },
          publisher: { "@id": organizationId },
          about: { "@id": softwareId },
          mainEntityOfPage: { "@id": webpageId },
          articleBody: [
            release.summary,
            release.direction,
            ...release.highlights.map((item) => `${item.title}: ${item.description}`),
          ].join("\n\n"),
        })),
      },
    ],
  };
}

export const latestReleaseDate = changelogCopy.en.releases[0]!.date;

export const sitemapEntries = [
  ...locales.map((locale) => ({
    locale,
    route: localeConfig[locale].route,
    alternates: Object.fromEntries(
      locales.map((alternate) => [localeConfig[alternate].language, localeConfig[alternate].route]),
    ),
    priority: locale === "en" ? "1.0" : "0.9",
  })),
  ...locales.map((locale) => ({
    locale,
    route: changelogRoutes[locale],
    alternates: Object.fromEntries(
      locales.map((alternate) => [localeConfig[alternate].language, changelogRoutes[alternate]]),
    ),
    priority: locale === "en" ? "0.8" : "0.7",
  })),
];
