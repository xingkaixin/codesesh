import { getSessionReferenceKey } from "@codesesh/contract";
import { useNodes } from "../../hooks/useNodes";
import { SourceBadge, sourceName } from "../nodes/SourceBadge";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Link } from "react-router-dom";
import type { AgentInfo, AppConfig, SearchResult, SourceNode } from "../../lib/api";
import { formatCompact, formatInt, formatRelativeTime, formatUsd } from "../../lib/format";
import { SEARCH_RESULT_LIMIT, searchResultPath } from "../../lib/search";
import { formatWindowLabel } from "../../lib/scan-format";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { AgentIcon } from "../AgentIcon";
import { SmartTagChips } from "../SmartTagChips";
import { SearchFilterBar } from "./SearchFilterBar";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";

const SEARCH_MESSAGES = {
  "Search range: {0}": ["搜索时间范围：{0}", "検索期間：{0}"],
  "Searches collected session titles, messages, tool output and file paths. Shows up to {0} sessions.":
    [
      "搜索已采集会话的标题、消息、工具输出和文件路径，最多展示 {0} 个会话。",
      "収集済みセッションのタイトル、メッセージ、ツール出力、ファイルパスを検索します。最大 {0} セッションを表示します。",
    ],
  "Showing the first {0} sessions. Narrow your query or filters to find a specific session.": [
    "已展示前 {0} 个会话。请细化关键词或筛选条件，查找目标会话。",
    "先頭の {0} セッションを表示しています。特定のセッションを探すには検索語やフィルターを絞り込んでください。",
  ],
  "Try another query, adjust filters, or change the time range above.": [
    "可尝试其他关键词、调整筛选条件，或更改上方的时间范围。",
    "検索語やフィルターを調整するか、上部の期間を変更してください。",
  ],
} as const;

const SEARCH_MATCH_LABELS: Record<SearchResult["matchType"], string> = {
  recent: "Recent",
  title: "Title",
  user_message: "User message",
  assistant_reply: "Assistant reply",
  tool_output: "Tool output",
  file_path: "File path",
};

function renderHighlightedSnippet(
  snippet: string,
  highlights: SearchResult["snippetHighlights"],
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const { start, end } of highlights) {
    if (start < cursor || end <= start || end > snippet.length) continue;
    if (start > cursor) nodes.push(snippet.slice(cursor, start));
    nodes.push(<mark key={`${start}-${end}`}>{snippet.slice(start, end)}</mark>);
    cursor = end;
  }

  if (cursor < snippet.length) nodes.push(snippet.slice(cursor));
  return nodes;
}

function SearchResultPreview({
  result,
  query,
  agent,
  agentLabel,
  nodes,
  onOpenResult,
}: {
  result: SearchResult;
  query: string;
  agent?: AgentInfo;
  agentLabel: string;
  nodes?: SourceNode[];
  onOpenResult: () => void;
}) {
  const { session } = result;
  const { stats } = session;
  const title = getSessionDisplayTitle(session);
  const tokens = stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;

  return (
    <aside
      aria-label={t("Result preview")}
      className="sticky top-0 hidden flex-col rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[var(--shadow-raised)] min-[1280px]:flex"
    >
      <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-2.5">
        {agent?.icon ? (
          <AgentIcon
            icon={agent.icon}
            iconColored={agent.iconColored}
            alt=""
            className="size-3.5 shrink-0 object-contain"
          />
        ) : null}
        <span className="console-mono truncate text-[11px] text-[var(--console-muted)]">
          #{result.reference.sessionId.slice(0, 8)} · {agentLabel}
        </span>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <section>
          <h3 className="text-base leading-snug font-semibold break-words text-[var(--console-text)]">
            {title}
          </h3>
          <p className="mt-1 text-xs text-[var(--console-muted)]">
            {formatRelativeTime(session.time_updated ?? session.time_created)} ·{" "}
            {t("{0} messages", [formatInt(stats.message_count)])} · {formatUsd(stats.total_cost)}
          </p>
        </section>
        {result.matchType !== "recent" && result.snippet ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-[var(--console-text)]">{t("Match")}</h4>
            <div className="flex flex-col gap-1 rounded-md border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-2.5">
              <span className="text-[11px] text-[var(--console-muted)]">
                {t(SEARCH_MATCH_LABELS[result.matchType])}
              </span>
              <p className="line-clamp-6 text-xs leading-5 break-words text-[var(--console-text-secondary)]">
                {renderHighlightedSnippet(result.snippet, result.snippetHighlights)}
              </p>
            </div>
          </section>
        ) : null}
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-[var(--console-border)] pt-4 text-xs">
          <dt className="text-[var(--console-muted)]">{t("Project")}</dt>
          <dd className="console-mono truncate text-[var(--console-text)]">
            {session.project_identity?.displayName ?? session.directory}
          </dd>
          <dt className="text-[var(--console-muted)]">{t("Tokens")}</dt>
          <dd className="console-mono text-[var(--console-text)]">{formatCompact(tokens)}</dd>
          <dt className="text-[var(--console-muted)]">{t("Source")}</dt>
          <dd className="text-[var(--console-text)]">
            {sourceName(result.reference.sourceNodeId ?? "local", nodes)}
          </dd>
        </dl>
        <SmartTagChips tags={session.smart_tags} limit={9} />
        <Link
          to={searchResultPath(result)}
          state={{ searchQuery: query }}
          onClick={onOpenResult}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--brand)] px-3 py-2 text-xs font-medium text-[var(--brand-fg)] motion-hover hover:bg-[var(--brand-hover)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-surface)] focus-visible:outline-none"
        >
          {t("Open session")}
          <kbd
            aria-hidden
            className="console-mono rounded-sm border border-current/30 px-1 text-[10px]"
          >
            Enter
          </kbd>
        </Link>
      </div>
    </aside>
  );
}

export function SearchResultsPanel({
  query,
  window,
  state,
  agentNameMap,
  agents,
  projects,
  filters,
  onChangeFilters,
  onOpenResult,
  onRetry,
  selectedIndex,
  registerResultRef,
}: {
  query: string;
  window?: AppConfig["window"] | null;
  state: SearchLoadState;
  agentNameMap: ReadonlyMap<string, string>;
  agents: AgentInfo[];
  projects: SearchProjectOption[];
  filters: SearchFilterState;
  onChangeFilters: Dispatch<SetStateAction<SearchFilterState>>;
  onOpenResult: () => void;
  onRetry: () => void;
  selectedIndex: number;
  registerResultRef: (key: string, node: HTMLAnchorElement | null) => void;
}) {
  const locale = useLocale();
  const nodes = useNodes();

  const results = state.status === "loaded" ? state.results : [];
  const filterBar = (
    <>
      <div className="space-y-1 text-xs leading-5 text-[var(--console-muted)]">
        <p className="font-medium text-[var(--console-text)]">
          {t(
            "Search range: {0}",
            [formatWindowLabel(window ? { window } : null) ?? t("Session time range")],
            locale,
            SEARCH_MESSAGES,
          )}
        </p>
        <p>
          {t(
            "Searches collected session titles, messages, tool output and file paths. Shows up to {0} sessions.",
            [SEARCH_RESULT_LIMIT],
            locale,
            SEARCH_MESSAGES,
          )}
        </p>
      </div>
      <SearchFilterBar
        agents={agents}
        projects={projects}
        filters={filters}
        onChangeFilters={onChangeFilters}
      />
    </>
  );

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3">
        {filterBar}
        <p className="sr-only" aria-live="polite">
          {t("Searching…")}
        </p>
        <div className="grid gap-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              data-testid="search-result-skeleton"
              className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 shadow-[var(--shadow-raised)]"
            >
              <div className="skeleton-shimmer h-3 w-32 rounded-sm" />
              <div className="skeleton-shimmer mt-3 h-4 w-2/3 rounded-sm" />
              <div className="skeleton-shimmer mt-2 h-3 w-full rounded-sm" />
              <div className="skeleton-shimmer mt-1 h-3 w-5/6 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="flex flex-col gap-3">
        {filterBar}
        <div
          className="rounded-lg border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6"
          aria-live="polite"
        >
          <h2 className="console-display text-[15px] font-semibold text-[var(--console-error)]">
            {t("Search Failed")}
          </h2>
          <p className="console-mono mt-2 break-words text-xs text-[var(--console-error)]">
            {state.error}
            {t(". Check the server connection, then try again.")}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="console-mono motion-hover motion-press mt-4 rounded-sm border border-[var(--console-error-border)] bg-[var(--console-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--console-error)] hover:bg-[var(--console-error-bg)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
          >
            {t("Retry Search")}
          </button>
        </div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {filterBar}
        <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 shadow-[var(--shadow-raised)]">
          <h2 className="console-display text-[15px] font-semibold text-[var(--console-text)]">
            {query ? t("No matches") : t("No recent sessions")}
          </h2>
          {query ? (
            <p className="console-mono mt-2 text-xs text-[var(--console-muted)]">
              {t("Query:")} {query}
            </p>
          ) : null}
          <p className="mt-2 text-xs leading-5 text-[var(--console-muted)]">
            {t(
              "Try another query, adjust filters, or change the time range above.",
              [],
              locale,
              SEARCH_MESSAGES,
            )}
          </p>
        </div>
      </div>
    );
  }

  const selected = results[Math.min(Math.max(selectedIndex, 0), results.length - 1)]!;
  const selectedAgentKey = selected.reference.agentName.toLowerCase();

  return (
    <div className="grid items-start gap-6 min-[1280px]:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 grid-cols-1 gap-3">
        {filterBar}
        <div className="console-mono text-[11px] text-[var(--console-muted)]">
          {t("Navigate j k · Open Enter · Exit Esc")}
        </div>
        {results.length === SEARCH_RESULT_LIMIT ? (
          <p role="status" className="text-xs leading-5 text-[var(--console-muted)]">
            {t(
              "Showing the first {0} sessions. Narrow your query or filters to find a specific session.",
              [SEARCH_RESULT_LIMIT],
              locale,
              SEARCH_MESSAGES,
            )}
          </p>
        ) : null}
        {results.map((result, index) => {
          const agentKey = result.reference.agentName.toLowerCase();
          const agentLabel = agentNameMap.get(agentKey) ?? result.reference.agentName;
          const resultKey = getSessionReferenceKey(result.reference);
          const isSelected = index === selectedIndex;
          const isUnmountedChild = Boolean(result.session.parent_reference) && !result.parent;

          return (
            <Link
              key={resultKey}
              ref={(node) => registerResultRef(resultKey, node)}
              to={searchResultPath(result)}
              state={{ searchQuery: query }}
              onClick={onOpenResult}
              data-selected={isSelected ? "true" : undefined}
              className={`rounded-lg border bg-[var(--console-surface)] p-4 shadow-[var(--shadow-raised)] motion-hover hover:border-[var(--console-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none ${
                isSelected ? "border-[var(--brand)]" : "border-[var(--console-border)]"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--console-muted)]">
                  {agentLabel}
                </span>
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--console-muted)]">
                  {t(SEARCH_MATCH_LABELS[result.matchType])}
                </span>
                <SourceBadge
                  sourceNodeId={result.reference.sourceNodeId ?? "local"}
                  nodes={nodes.data?.nodes}
                />
                {isUnmountedChild ? (
                  <span className="console-mono rounded-sm border border-[var(--console-border-strong)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                    {t("Unmounted")}
                  </span>
                ) : null}
                <span className="console-mono min-w-0 break-all text-[11px] text-[var(--console-muted)]">
                  {result.session.directory}
                </span>
              </div>
              {result.parent ? (
                <p className="console-mono mt-3 line-clamp-1 text-[11px] text-[var(--console-muted)]">
                  {result.parent.title}
                </p>
              ) : null}
              <h2
                className={`text-[13px] font-semibold text-[var(--console-text)] ${
                  result.parent ? "mt-1 flex items-center gap-1.5 pl-3" : "mt-3"
                }`}
              >
                {result.parent ? (
                  <span aria-hidden="true" className="console-mono text-[var(--brand)]">
                    ›
                  </span>
                ) : null}
                {getSessionDisplayTitle(result.session)}
              </h2>
              <SmartTagChips tags={result.session.smart_tags} className="mt-2" />
              <p className="mt-2 text-xs leading-6 text-[var(--console-text-secondary)]">
                {renderHighlightedSnippet(
                  result.snippet || getSessionDisplayTitle(result.session),
                  result.snippet ? result.snippetHighlights : [],
                )}
              </p>
            </Link>
          );
        })}
      </div>
      <SearchResultPreview
        result={selected}
        query={query}
        agent={agents.find((agent) => agent.name.toLowerCase() === selectedAgentKey)}
        agentLabel={agentNameMap.get(selectedAgentKey) ?? selected.reference.agentName}
        nodes={nodes.data?.nodes}
        onOpenResult={onOpenResult}
      />
    </div>
  );
}
