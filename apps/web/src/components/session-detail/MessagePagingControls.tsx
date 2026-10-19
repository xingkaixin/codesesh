import { useEffect, useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import type { SessionMessagePaging } from "../../hooks/useSessionDetail";
import { t } from "../../i18n/translate";

const MESSAGES = {
  "Loaded {0} of {1} messages": [
    "已加载 {0} / {1} 条消息",
    "{1} 件中 {0} 件のメッセージを読み込みました",
  ],
  "Filters and navigation apply to loaded messages.": [
    "筛选和消息导航仅作用于已加载的消息。",
    "フィルターとメッセージナビゲーションは読み込み済みの内容に適用されます。",
  ],
  "Load more messages": ["加载更多消息", "さらにメッセージを読み込む"],
  "Load all messages": ["加载全部消息", "すべてのメッセージを読み込む"],
  "Loading all messages…": ["正在加载全部消息…", "すべてのメッセージを読み込み中…"],
  "Loading search match…": ["正在加载搜索命中位置…", "検索結果の位置を読み込み中…"],
  "Couldn’t load more messages. Try again.": [
    "无法加载更多消息，请重试。",
    "追加のメッセージを読み込めませんでした。再試行してください。",
  ],
} as const;

const BUTTON_CLASS =
  "rounded-sm border border-[var(--console-border)] px-3 py-1.5 text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50";

export function MessagePagingControls({
  loaded,
  total,
  paging: { loading, failed, loadMore },
  searchMatchPending = false,
  showLoadAll = false,
}: {
  loaded: number;
  total: number;
  paging: SessionMessagePaging;
  searchMatchPending?: boolean;
  showLoadAll?: boolean;
}) {
  const locale = useLocale();
  const [loadAll, setLoadAll] = useState(false);
  useEffect(() => {
    if (loadAll && !loading && !failed) loadMore();
  }, [loadAll, loading, failed, loadMore, loaded]);

  return (
    <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 text-xs leading-5 text-[var(--console-muted)]">
      <p role="status">
        {t("Loaded {0} of {1} messages", [loaded, total], locale, MESSAGES)}
        {searchMatchPending && !failed
          ? ` · ${t("Loading search match…", [], locale, MESSAGES)}`
          : ""}
      </p>
      <p>{t("Filters and navigation apply to loaded messages.", [], locale, MESSAGES)}</p>
      {failed && (
        <p role="alert">{t("Couldn’t load more messages. Try again.", [], locale, MESSAGES)}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={loading} onClick={loadMore} className={BUTTON_CLASS}>
          {loading ? t("Loading…") : t("Load more messages", [], locale, MESSAGES)}
        </button>
        {showLoadAll && (
          <button
            type="button"
            disabled={loading || (loadAll && !failed)}
            onClick={() => {
              setLoadAll(true);
              if (failed) loadMore();
            }}
            className={BUTTON_CLASS}
          >
            {t(
              loadAll && !failed ? "Loading all messages…" : "Load all messages",
              [],
              locale,
              MESSAGES,
            )}
          </button>
        )}
      </div>
    </div>
  );
}
