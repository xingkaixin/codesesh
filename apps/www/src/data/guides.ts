import { localeConfig, locales, siteUrl, type Locale } from "./landing";

interface Guide {
  slug: string;
  category: "start" | "connect" | "understand";
  updated: string;
  copy: Record<Locale, { title: string; description: string }>;
}

export const guides: Guide[] = [
  {
    slug: "getting-started",
    category: "start",
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
    updated: "2026-10-03",
    copy: {
      en: {
        title: "How to find Claude Code and Codex session history",
        description:
          "Find local Claude Code and Codex conversations with CodeSesh. Search by project or file, replay tool activity, and troubleshoot missing sessions.",
      },
      zh: {
        title: "如何查找 Claude Code 和 Codex 的历史会话",
        description:
          "使用 CodeSesh 查找本地 Claude Code 和 Codex 对话：按项目或文件搜索，回放工具调用，并排查历史会话缺失的原因。",
      },
      ja: {
        title: "Claude Code と Codex の会話履歴を探す方法",
        description:
          "CodeSesh で Claude Code と Codex の会話を探す手順。プロジェクトやファイルでの検索、ツール操作の確認、履歴が見つからない場合の調べ方を説明します。",
      },
    },
  },
  {
    slug: "lan-access",
    category: "connect",
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
    related: "Related guides",
    all: "Browse all guides",
    start: "Start locally",
    connect: "Connect your devices",
    understand: "Understand usage",
    intro: "Choose what you want to do",
    by: "By CodeSesh",
  },
  zh: {
    title: "CodeSesh 使用指南",
    label: "使用指南",
    description:
      "从浏览本地 AI 编码历史，到连接多台电脑、理解用量，按实际使用场景了解 CodeSesh 的配置与操作。",
    home: "首页",
    updated: "更新于",
    contents: "本文目录",
    related: "相关指南",
    all: "查看全部指南",
    start: "开始在本机使用",
    connect: "连接你的设备",
    understand: "理解用量",
    intro: "从你想完成的事情开始",
    by: "作者：CodeSesh",
  },
  ja: {
    title: "CodeSesh の使い方",
    label: "使い方",
    description:
      "ローカルの AI コーディング履歴の閲覧、複数端末の接続、使用量の確認まで。目的に合わせた CodeSesh の設定と操作を紹介します。",
    home: "ホーム",
    updated: "更新日",
    contents: "目次",
    related: "関連ガイド",
    all: "すべてのガイド",
    start: "ローカルで使う",
    connect: "端末を接続する",
    understand: "使用量を知る",
    intro: "やりたいことから探す",
    by: "著者：CodeSesh",
  },
} satisfies Record<Locale, Record<string, string>>;

export function guideRoutes(slug = ""): Record<Locale, string> {
  return {
    en: `/guides/${slug ? `${slug}/` : ""}`,
    zh: `/zh/guides/${slug ? `${slug}/` : ""}`,
    ja: `/ja/guides/${slug ? `${slug}/` : ""}`,
  };
}

export function guidePageConfig(locale: Locale, guide?: Guide) {
  const t = guideCopy[locale];
  const content = guide?.copy[locale] ?? t;
  const routes = guideRoutes(guide?.slug);
  const url = new URL(routes[locale], siteUrl).toString();
  const indexUrl = new URL(guideRoutes()[locale], siteUrl).toString();
  const breadcrumbs = [
    { name: t.home, item: new URL(localeConfig[locale].route, siteUrl).toString() },
    { name: t.label, item: indexUrl },
    ...(guide ? [{ name: content.title, item: url }] : []),
  ];
  return {
    title: guide ? `${content.title} | CodeSesh` : t.title,
    description: content.description,
    route: routes[locale],
    alternateRoutes: routes,
    ogType: guide ? "article" : "website",
    schema: [
      {
        "@type": guide ? "WebPage" : "CollectionPage",
        "@id": `${url}#webpage`,
        url,
        name: content.title,
        description: content.description,
        inLanguage: localeConfig[locale].language,
        isPartOf: { "@id": `${siteUrl}/#website` },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        mainEntity: { "@id": `${url}#${guide ? "article" : "guides"}` },
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
              headline: content.title,
              description: content.description,
              inLanguage: localeConfig[locale].language,
              dateModified: guide.updated,
              author: { "@id": `${siteUrl}/#organization` },
              publisher: { "@id": `${siteUrl}/#organization` },
              mainEntityOfPage: { "@id": `${url}#webpage` },
              url,
            },
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

export const guideSitemapEntries = [undefined, ...guides].flatMap((guide) =>
  locales.map((locale) => ({
    route: guideRoutes(guide?.slug)[locale],
    alternates: Object.fromEntries(
      locales.map((key) => [localeConfig[key].language, guideRoutes(guide?.slug)[key]]),
    ),
    priority: "0.8",
    lastmod: guide?.updated ?? "2026-10-03",
  })),
);
