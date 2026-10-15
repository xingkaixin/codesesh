import type { Locale } from "./landing";

interface SectionCopy {
  heroResults: string;
  heroVisual: string;
  tour: {
    activity: string;
    ranges: [string, string, string];
    sessionsUnit: string;
    rollup: string;
    expand: string;
    userBadge: string;
    prompt: string;
    firstReply: string;
    replayReply: string;
    finalReply: string;
  };
  local: {
    label: string;
    boundary: string;
    chain: [string, string][];
    cloud: string;
    cloudNote: string;
    worker: string;
  };
  hub: {
    label: string;
    title: [string, string];
    body: string;
    points: [string, string][];
    connected: string;
    collecting: string;
    offline: string;
    queued: string;
    hubRole: string;
    hubFoot: string;
    guide: string;
  };
  install: {
    label: string;
  };
}

export const sections = {
  en: {
    heroResults: "3 sessions · 2 projects",
    heroVisual:
      "Sessions from several agents flow into one local, searchable index: a search for refresh 401 finds 3 sessions · 2 projects and previews the session replay on the right",
    tour: {
      activity: "Daily activity",
      ranges: ["7d", "30d", "All"],
      sessionsUnit: "sessions",
      rollup: "rolled up by hierarchy",
      expand: "Show subagent session",
      userBadge: "User",
      prompt: "The refresh endpoint sometimes returns 401 twice in a row. Find out why.",
      firstReply:
        "Two requests can start a refresh at the same time. Checking the middleware first.",
      replayReply:
        "Two requests can start a refresh at the same time. Checking the middleware first, then when the token is written back.",
      finalReply:
        "Refresh is now single-flight. Concurrent requests share one promise, and the auth tests pass.",
    },
    local: {
      label: "Data boundary",
      boundary: "Your machine",
      chain: [
        ["Agent logs", "~/.claude · ~/.codex · …"],
        ["CodeSesh scan", "Rust · incremental"],
        ["SQLite index", "messages · FTS · cost"],
        ["Web UI", "localhost:4521"],
      ],
      cloud: "Cloud upload",
      cloudNote: "never in standalone mode",
      worker:
        "Optional Workers send sessions to a Hub you host yourself. Attachments and source files are never transferred.",
    },
    hub: {
      label: "Multi-machine",
      title: ["Many machines.", "One history."],
      body: "Run a Hub where you browse, and pair a Worker on each computer you code on. Workers collect locally and upload to your self-hosted Hub. The Hub handles search, cost estimates, and the Web UI.",
      points: [
        [
          "Pair once",
          "A one-time token, valid for 10 minutes, becomes a revocable per-node credential. The Hub stores only its digest.",
        ],
        [
          "Keeps working offline",
          "When the Hub is unreachable, Workers keep collecting, queue uploads on disk, and catch up after reconnecting.",
        ],
        [
          "See every source",
          "The source-node panel shows collection progress and errors, starts rescans, and replaces Workers. Background services run on macOS, Linux, and Windows.",
        ],
      ],
      connected: "Connected",
      collecting: "Collecting",
      offline: "Offline",
      queued: "{count} queued",
      hubRole: "Query-only Web UI. Collects nothing itself.",
      hubFoot: "Search, stats, and cost across machines",
      guide: "Collect history from multiple computers",
    },
    install: {
      label: "Install",
    },
  },
  zh: {
    heroResults: "3 个会话 · 2 个项目",
    heroVisual:
      "多个 Agent 的会话汇入同一个可搜索的本地索引：搜索 refresh 401，命中 3 个会话 · 2 个项目，并在右侧预览会话回放",
    tour: {
      activity: "每日活跃",
      ranges: ["7 天", "30 天", "全部"],
      sessionsUnit: "个会话",
      rollup: "按层级汇总",
      expand: "展开子 Agent 会话",
      userBadge: "用户",
      prompt: "refresh 接口偶尔会连续返回两次 401，帮我查一下原因。",
      firstReply: "两个请求可能同时触发刷新。先看一下中间件。",
      replayReply: "两个请求可能同时触发刷新。先看一下中间件，再确认 token 写回的时机。",
      finalReply: "刷新改为 single-flight，并发请求共享同一个 Promise，auth 测试全部通过。",
    },
    local: {
      label: "数据边界",
      boundary: "你的电脑",
      chain: [
        ["Agent 日志", "~/.claude · ~/.codex · …"],
        ["CodeSesh 扫描", "Rust · 增量"],
        ["SQLite 索引", "消息 · FTS · 成本"],
        ["Web UI", "localhost:4521"],
      ],
      cloud: "云端上传",
      cloudNote: "单机模式下不会发生",
      worker: "可选的 Worker 会把会话发送到你自托管的 Hub，不传输附件或源文件。",
    },
    hub: {
      label: "多机同步",
      title: ["多台电脑，", "一份历史。"],
      body: "在你浏览的地方运行 Hub，在每台写代码的电脑上配对一个 Worker。Worker 在本机采集并上传到你自托管的 Hub，Hub 负责搜索、成本估算和 Web UI。",
      points: [
        ["配对一次", "一次性令牌 10 分钟内有效，换取可撤销的节点凭据；Hub 只保存凭据摘要。"],
        ["离线也不丢", "Hub 暂时不可达时，Worker 继续采集，把待上传内容存在本地，恢复连接后补传。"],
        [
          "每个来源都看得见",
          "来源节点面板显示采集进度和异常，可触发重扫、替换 Worker。后台服务支持 macOS、Linux 和 Windows。",
        ],
      ],
      connected: "已连接",
      collecting: "采集中",
      offline: "离线",
      queued: "积压 {count}",
      hubRole: "只提供查询和 Web UI，本身不采集。",
      hubFoot: "跨机器搜索、统计与成本",
      guide: "用 Hub 和 Worker 汇总多台电脑的历史",
    },
    install: {
      label: "安装",
    },
  },
  ja: {
    heroResults: "3セッション · 2プロジェクト",
    heroVisual:
      "複数のエージェントのセッションが1つのローカル検索インデックスに集まる：refresh 401 を検索すると 3セッション · 2プロジェクトがヒットし、右側でセッションのリプレイをプレビュー",
    tour: {
      activity: "日別アクティビティ",
      ranges: ["7日", "30日", "全期間"],
      sessionsUnit: "件",
      rollup: "階層ごとに集計",
      expand: "サブエージェントのセッションを表示",
      userBadge: "ユーザー",
      prompt: "refresh エンドポイントがときどき 401 を2回続けて返す。原因を調べて。",
      firstReply:
        "2つのリクエストが同時にリフレッシュを始める可能性があります。まずミドルウェアを確認します。",
      replayReply:
        "2つのリクエストが同時にリフレッシュを始める可能性があります。まずミドルウェアを確認し、次に token を書き戻すタイミングを確かめます。",
      finalReply:
        "リフレッシュを single-flight にしました。同時リクエストは同じ Promise を共有し、auth テストは通過しています。",
    },
    local: {
      label: "データの境界",
      boundary: "あなたのPC",
      chain: [
        ["エージェントのログ", "~/.claude · ~/.codex · …"],
        ["CodeSesh スキャン", "Rust · 増分"],
        ["SQLite インデックス", "メッセージ · FTS · コスト"],
        ["Web UI", "localhost:4521"],
      ],
      cloud: "クラウドへのアップロード",
      cloudNote: "単体モードでは行いません",
      worker:
        "任意の Worker は、セルフホストの Hub にセッションを送信します。添付ファイルや元のファイルは転送しません。",
    },
    hub: {
      label: "マルチマシン",
      title: ["複数のマシンを、", "ひとつの履歴に。"],
      body: "閲覧する場所で Hub を動かし、コードを書く各マシンで Worker をペアリング。Worker がローカルで収集してセルフホストの Hub に送信し、Hub が検索、コスト推定、Web UI を担います。",
      points: [
        [
          "ペアリングは一度だけ",
          "10分間有効な一回限りのトークンを、取り消し可能なノード認証情報に交換。Hub はそのダイジェストだけを保存します。",
        ],
        [
          "オフラインでも止まらない",
          "Hub に接続できない間も Worker は収集を続け、送信待ちをローカルに保存し、再接続後に追いつきます。",
        ],
        [
          "すべての収集元を確認",
          "収集元ノードのパネルで進捗やエラーを確認し、再スキャンや Worker の置き換えができます。バックグラウンドサービスは macOS、Linux、Windows に対応。",
        ],
      ],
      connected: "接続中",
      collecting: "収集中",
      offline: "オフライン",
      queued: "送信待ち {count}",
      hubRole: "閲覧専用の Web UI。Hub 自体は収集しません。",
      hubFoot: "マシンをまたいだ検索・統計・コスト",
      guide: "複数のパソコンの履歴をまとめる",
    },
    install: {
      label: "インストール",
    },
  },
} satisfies Record<Locale, SectionCopy>;
