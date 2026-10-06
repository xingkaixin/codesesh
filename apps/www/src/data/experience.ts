import type { Locale } from "./landing";

export const experience = {
  en: {
    start: "Get CodeSesh",
    tour: "Explore the product",
    tourTitle: "The whole story. In one place.",
    tourBody:
      "Explore a working sample. Change the date range, open a project, or step through a conversation.",
    tabs: ["Overview", "Projects", "Replay"],
    localTitle: ["Your history.", "On your machine."],
    localBody:
      "Your sessions and search index stay on your computer by default. No account. No session telemetry. Free and open source.",
    localLink: "Read about your data",
    agentsTitle: "Different agents. Same workspace.",
    agentsCount: "supported agents",
    installTitle: ["Keep the context.", "Start here."],
    installBody:
      "One command opens your local coding history. Choose the installation method that works for you.",
    skip: "Skip to content",
    menu: "Menu",
  },
  zh: {
    start: "开始使用",
    tour: "探索产品",
    tourTitle: "完整的工作记录，一个地方看清。",
    tourBody: "试试这些交互示例。切换时间范围、展开项目，或逐条回顾对话。",
    tabs: ["用量概览", "项目会话", "会话回放"],
    localTitle: ["你的记录，", "留在你的电脑。"],
    localBody: "默认在本机保存会话与搜索索引。无需账号，不收集会话遥测。免费，开源。",
    localLink: "了解数据存储方式",
    agentsTitle: "不同的 Agent，同一个工作空间。",
    agentsCount: "种受支持的 Agent",
    installTitle: ["保留上下文，", "从这里开始。"],
    installBody: "一条命令，打开本地编码历史。选择适合你的安装方式。",
    skip: "跳到正文",
    menu: "菜单",
  },
  ja: {
    start: "使い始める",
    tour: "製品を見る",
    tourTitle: "作業の全体像を、ひとつの場所で。",
    tourBody:
      "サンプルを操作してみてください。期間の切り替え、プロジェクトの展開、会話の再生を試せます。",
    tabs: ["利用状況", "プロジェクト", "会話の再生"],
    localTitle: ["あなたの履歴を、", "あなたのPCに。"],
    localBody:
      "会話と検索インデックスは、標準ではPC内に保存。アカウント不要。会話のテレメトリなし。無料・オープンソース。",
    localLink: "データの保存について",
    agentsTitle: "エージェントが違っても、同じ場所に。",
    agentsCount: "種類の対応エージェント",
    installTitle: ["履歴を手元に。", "ここから始める。"],
    installBody:
      "コマンドひとつで、ローカルのコーディング履歴を表示。使いやすい方法でインストールできます。",
    skip: "本文へ移動",
    menu: "メニュー",
  },
} satisfies Record<Locale, Record<string, string | string[]>>;
