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
