import { localeConfig, siteUrl, type Locale } from "./landing";

export const sessionHistoryRoutes = {
  en: "/guides/session-history/",
  zh: "/zh/guides/session-history/",
  ja: "/ja/guides/session-history/",
} satisfies Record<Locale, string>;

export const sessionHistoryUpdated = "2026-09-19";

export const sessionHistoryCopy = {
  en: {
    title: "How to Find Claude Code and Codex Session History",
    description:
      "Find local Claude Code and Codex conversations with CodeSesh. Start the viewer, search by project or file, and troubleshoot missing sessions.",
    label: "Session history guide",
    home: "CodeSesh overview",
    updated: "Updated",
    start: "Start CodeSesh locally",
  },
  zh: {
    title: "如何查找 Claude Code 和 Codex 的历史会话",
    description:
      "使用 CodeSesh 查找本地 Claude Code 和 Codex 对话：启动查看器，按项目或文件搜索，并排查历史会话缺失的原因。",
    label: "历史会话查找指南",
    home: "CodeSesh 产品介绍",
    updated: "更新于",
    start: "在本机启动 CodeSesh",
  },
  ja: {
    title: "Claude Code と Codex の会話履歴を探す方法",
    description:
      "CodeSesh でローカルの Claude Code と Codex の会話を探す手順。起動、プロジェクトやファイルでの検索、履歴が見つからない場合の確認方法を説明します。",
    label: "会話履歴の検索ガイド",
    home: "CodeSesh の製品紹介",
    updated: "更新日",
    start: "ローカルで CodeSesh を起動",
  },
} satisfies Record<
  Locale,
  {
    title: string;
    description: string;
    label: string;
    home: string;
    updated: string;
    start: string;
  }
>;

export function createSessionHistoryPageConfig(locale: Locale) {
  const t = sessionHistoryCopy[locale];
  const url = new URL(sessionHistoryRoutes[locale], siteUrl).toString();
  return {
    title: `${t.title} | CodeSesh`,
    description: t.description,
    route: sessionHistoryRoutes[locale],
    alternateRoutes: sessionHistoryRoutes,
    schema: [
      {
        "@type": "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: t.title,
        description: t.description,
        inLanguage: localeConfig[locale].language,
        dateModified: sessionHistoryUpdated,
        isPartOf: { "@id": `${siteUrl}/#website` },
      },
    ],
  };
}
