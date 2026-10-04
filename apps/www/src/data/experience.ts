import type { Locale } from "./landing";

export const experience = {
  en: {
    intro: "Your AI coding history, together.",
    title: ["Good work.", "Worth keeping."],
    body: "Find the conversation, retrace the decision, pick up where you left off. All your agents. One local workspace.",
    start: "Get CodeSesh",
    tour: "Explore the product",
    tourTitle: "The whole story. In one place.",
    tourBody:
      "Explore a working sample. Change the date range, open a project, or step through a conversation.",
    tabs: ["Overview", "Projects", "Replay"],
    featuresTitle: "Less searching. More context.",
    featuresBody: "The work you did yesterday should help you build today.",
    screenshot: "Product screenshot with sample data",
    searchTitle: "Find the part you remember.",
    searchBody:
      "A phrase, a file, a tool call. Search across your agents and return to the original conversation.",
    replayTitle: "Every step, still there.",
    replayBody:
      "Read the prompt, the reasoning, and the changes together. Follow a task from first question to final result.",
    localTitle: ["Your history.", "On your machine."],
    localBody:
      "Your sessions and search index stay on your computer by default. No account. No session telemetry. Free and open source.",
    localLink: "Read about your data",
    agentsTitle: "Different agents. Same workspace.",
    agentsBody:
      "Keep using the tools you love. CodeSesh brings their local histories together, automatically.",
    agentsCount: "supported agents",
    installTitle: ["Keep the context.", "Start here."],
    installBody:
      "One command opens your local coding history. Choose the installation method that works for you.",
    skip: "Skip to content",
    menu: "Menu",
  },
  zh: {
    intro: "把 AI 编码历史，放在一起。",
    title: ["每次投入，", "都有迹可循。"],
    body: "找回对话，回顾决策，接着上次的进度。所有 Agent 的编码历史，在本机统一查看。",
    start: "开始使用",
    tour: "探索产品",
    tourTitle: "完整的工作记录，一个地方看清。",
    tourBody: "试试这些交互示例。切换时间范围、展开项目，或逐条回顾对话。",
    tabs: ["用量概览", "项目会话", "会话回放"],
    featuresTitle: "少一点翻找，多一点上下文。",
    featuresBody: "让昨天的工作，成为今天继续开发的依据。",
    screenshot: "产品截图，使用示例数据",
    searchTitle: "记得一点，就能找到。",
    searchBody: "一句话、一个文件、一次工具调用。跨 Agent 搜索，回到当时的完整对话。",
    replayTitle: "每一步，都能回看。",
    replayBody: "把提问、推理和文件变更放在一起，沿着时间线，回顾一次任务的全过程。",
    localTitle: ["你的记录，", "留在你的电脑。"],
    localBody: "默认在本机保存会话与搜索索引。无需账号，不收集会话遥测。免费，开源。",
    localLink: "了解数据存储方式",
    agentsTitle: "不同的 Agent，同一个工作空间。",
    agentsBody: "继续用你喜欢的工具。CodeSesh 自动发现并汇集它们的本地历史。",
    agentsCount: "种受支持的 Agent",
    installTitle: ["保留上下文，", "从这里开始。"],
    installBody: "一条命令，打开本地编码历史。选择适合你的安装方式。",
    skip: "跳到正文",
    menu: "菜单",
  },
  ja: {
    intro: "AIコーディングの履歴を、ひとつに。",
    title: ["積み重ねた仕事を、", "いつでも手元に。"],
    body: "会話を探し、判断を振り返り、続きを始める。すべてのエージェントの履歴を、ローカルでまとめて確認。",
    start: "使い始める",
    tour: "製品を見る",
    tourTitle: "作業の全体像を、ひとつの場所で。",
    tourBody:
      "サンプルを操作してみてください。期間の切り替え、プロジェクトの展開、会話の再生を試せます。",
    tabs: ["利用状況", "プロジェクト", "会話の再生"],
    featuresTitle: "探す時間を減らし、続きを始める。",
    featuresBody: "昨日の仕事を、今日の開発に役立てる。",
    screenshot: "サンプルデータを使用した製品画面",
    searchTitle: "覚えている一言から、見つかる。",
    searchBody:
      "フレーズ、ファイル、ツール呼び出し。エージェントを横断して検索し、元の会話へ戻れます。",
    replayTitle: "どの手順も、振り返れる。",
    replayBody:
      "質問、推論、ファイル変更をまとめて確認。最初の問いから結果まで、作業の流れをたどれます。",
    localTitle: ["あなたの履歴を、", "あなたのPCに。"],
    localBody:
      "会話と検索インデックスは、標準ではPC内に保存。アカウント不要。会話のテレメトリなし。無料・オープンソース。",
    localLink: "データの保存について",
    agentsTitle: "エージェントが違っても、同じ場所に。",
    agentsBody:
      "好きなツールをそのまま使えます。CodeSeshがローカルの履歴を自動で検出し、まとめます。",
    agentsCount: "種類の対応エージェント",
    installTitle: ["履歴を手元に。", "ここから始める。"],
    installBody:
      "コマンドひとつで、ローカルのコーディング履歴を表示。使いやすい方法でインストールできます。",
    skip: "本文へ移動",
    menu: "メニュー",
  },
} satisfies Record<Locale, Record<string, string | string[]>>;
