import type { Dispatch, SetStateAction } from "react";
import { Link } from "react-router-dom";
import type { AgentInfo, SearchResult } from "../../lib/api";
import { sessionRoutePath } from "../../lib/session-indexes";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { SmartTagChips } from "../SmartTagChips";
import { SearchFilterBar } from "./SearchFilterBar";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";

const SEARCH_MATCH_LABELS: Record<SearchResult["matchType"], string> = {
  recent: "Recent",
  title: "Title",
  user_message: "User message",
  assistant_reply: "Assistant reply",
  tool_output: "Tool output",
  file_path: "File path",
};

function toSafeSnippetHtml(snippet: string): string {
  return snippet
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("&lt;mark&gt;", "<mark>")
    .replaceAll("&lt;/mark&gt;", "</mark>");
}

export function SearchResultsPanel({
  query,
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
  const results = state.status === "loaded" ? state.results : [];
  const filterBar = (
    <SearchFilterBar
      agents={agents}
      projects={projects}
      filters={filters}
      onChangeFilters={onChangeFilters}
    />
  );

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3">
        {filterBar}
        <p className="sr-only" aria-live="polite">
          Searching…
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
            Search Failed
          </h2>
          <p className="console-mono mt-2 break-words text-xs text-[var(--console-error)]">
            {state.error}. Check the server connection, then try again.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="console-mono motion-hover motion-press mt-4 rounded-sm border border-[var(--console-error-border)] bg-[var(--console-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--console-error)] hover:bg-[var(--console-error-bg)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
          >
            Retry Search
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
            {query ? "No matches" : "No recent sessions"}
          </h2>
          {query ? (
            <p className="console-mono mt-2 text-xs text-[var(--console-muted)]">Query: {query}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {filterBar}
      <div className="console-mono text-[11px] text-[var(--console-muted)]">
        Navigate j k · Open Enter · Exit Esc
      </div>
      {results.map((result, index) => {
        const agentKey = result.reference.agentName.toLowerCase();
        const agentLabel = agentNameMap.get(agentKey) ?? result.reference.agentName;
        const resultKey = `${result.reference.agentName}/${result.reference.sessionId}`;
        const isSelected = index === selectedIndex;
        const isUnmountedChild = Boolean(result.session.parent_reference) && !result.parent;

        return (
          <Link
            key={resultKey}
            ref={(node) => registerResultRef(resultKey, node)}
            to={sessionRoutePath(result.reference)}
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
                {SEARCH_MATCH_LABELS[result.matchType]}
              </span>
              {isUnmountedChild ? (
                <span className="console-mono rounded-sm border border-[var(--console-border-strong)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                  未挂载
                </span>
              ) : null}
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
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
            <p
              className="mt-2 text-xs leading-6 text-[var(--console-text-secondary)]"
              dangerouslySetInnerHTML={{
                __html: toSafeSnippetHtml(result.snippet || getSessionDisplayTitle(result.session)),
              }}
            />
          </Link>
        );
      })}
    </div>
  );
}
