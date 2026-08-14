import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import { findAgent, type AgentCatalog } from "../lib/agents";
import type { SessionHead } from "../lib/api";
import { formatCostSource, formatMoney, formatNumber, formatRelativeTime } from "../lib/format";
import { agentRoutePath, sessionRoutePath } from "../lib/session-indexes";
import { getSessionDisplayTitle } from "../lib/session-title";
import { AgentIcon } from "./AgentIcon";
import { BookmarkButton } from "./BookmarkButton";
import { SmartTagChips } from "./SmartTagChips";
import { Panel, PanelHeader } from "./ui/panel";

export interface LandingSession extends SessionHead {
  agentKey: string;
  sessionId: string;
  reference: string;
}

export interface LandingAgentItem {
  key: string;
  name: string;
  icon?: string;
  iconColored?: boolean;
  count: number;
}

interface DetailLandingProps {
  type: "global" | "agent" | "missing-agent" | "missing-session" | "load-failed";
  agentCatalog: AgentCatalog;
  sessions: LandingSession[];
  agentItems: LandingAgentItem[];
  activeAgentKey?: string;
  attemptedAgentKey?: string;
  attemptedSessionId?: string | null;
  loadFailureMessage?: string;
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  onToggleBookmark: (session: LandingSession) => void;
  onRetry?: () => void;
}

function getSessionTotalTokens(stats: SessionHead["stats"]) {
  return stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
}

function LandingCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Panel className="p-4">
      <p className="console-eyebrow">{label}</p>
      <p className="console-mono mt-2 text-xl font-semibold text-[var(--console-text)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--console-muted)]">{hint}</p> : null}
    </Panel>
  );
}

function DiagnosticItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3">
      <p className="console-eyebrow">{label}</p>
      <p className="console-mono mt-2 break-all text-sm leading-6 text-[var(--console-text)]">
        {value}
      </p>
    </div>
  );
}

function MissingStateHero({
  code,
  title,
  description,
  aside,
  iconSrc,
  iconColored,
  iconAlt,
}: {
  code: string;
  title: string;
  description: string;
  aside: string;
  iconSrc?: string;
  iconColored?: boolean;
  iconAlt?: string;
}) {
  return (
    <Panel className="p-5 md:p-6">
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div className="max-w-2xl">
          <span className="console-eyebrow inline-flex rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2.5 py-1">
            {code}
          </span>
          <div className="mt-4 flex items-start gap-3">
            {iconSrc ? (
              <AgentIcon
                icon={iconSrc}
                iconColored={iconColored}
                alt={iconAlt || ""}
                className="mt-1 size-8 shrink-0 object-contain"
              />
            ) : null}
            <h2 className="console-display text-2xl leading-tight font-semibold text-[var(--console-text)] md:text-[2rem]">
              {title}
            </h2>
          </div>
          <p className="mt-3 max-w-[42rem] text-sm leading-7 text-[var(--console-muted)]">
            {description}
          </p>
        </div>
        <div className="min-w-0 rounded-md border border-dashed border-[var(--console-border)] bg-[var(--console-surface-muted)] px-4 py-3 md:max-w-xs">
          <p className="console-eyebrow">STATUS NOTE</p>
          <p className="mt-2 text-sm leading-6 text-[var(--console-text)]">{aside}</p>
        </div>
      </div>
    </Panel>
  );
}

function RecommendedAgents({ agentItems }: { agentItems: LandingAgentItem[] }) {
  return (
    <Panel className="p-4">
      <PanelHeader title="Known Agents" meta={`${agentItems.length} items`} />
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {agentItems.map((agent) => (
          <li key={agent.key}>
            <Link
              to={agentRoutePath(agent.key)}
              className="flex min-h-11 items-center gap-2 rounded-sm border border-transparent px-3 py-2 motion-hover hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)]"
            >
              {agent.icon ? (
                <AgentIcon
                  icon={agent.icon}
                  iconColored={agent.iconColored}
                  alt={agent.name}
                  className="size-4 object-contain"
                />
              ) : null}
              <span className="console-mono flex-1 text-xs text-[var(--console-text)]">
                {agent.name}
              </span>
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
                {agent.count}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function RecentSessions({
  sessions,
  isBookmarked,
  onToggleBookmark,
}: {
  sessions: LandingSession[];
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  onToggleBookmark: (session: LandingSession) => void;
}) {
  if (sessions.length === 0) {
    return <Panel className="p-4 text-sm text-[var(--console-muted)]">No sessions yet</Panel>;
  }

  return (
    <Panel className="p-4">
      <PanelHeader title="Recent Sessions" meta={`${sessions.length} items`} />
      <ul className="mt-3 space-y-2">
        {sessions.map((session) => {
          const bookmarked = isBookmarked(session.agentKey, session.id);
          return (
            <li key={session.id}>
              <div className="flex items-start gap-2 rounded-sm border border-transparent px-2 py-1.5 motion-hover hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]">
                <Link
                  to={sessionRoutePath({
                    agentName: session.agentKey,
                    sessionId: session.sessionId,
                  })}
                  className="min-w-0 flex-1"
                >
                  <p className="line-clamp-1 text-sm text-[var(--console-text)]">
                    {getSessionDisplayTitle(session)}
                  </p>
                  <p className="console-mono mt-0.5 text-[11px] text-[var(--console-muted)]">
                    /{session.reference} ·{" "}
                    {formatRelativeTime(session.time_updated || session.time_created)}
                  </p>
                  <SmartTagChips tags={session.smart_tags} className="mt-1.5" />
                </Link>
                <BookmarkButton active={bookmarked} onToggle={() => onToggleBookmark(session)} />
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export const DetailLanding = memo(function DetailLanding({
  type,
  agentCatalog,
  sessions,
  agentItems,
  activeAgentKey,
  attemptedAgentKey,
  attemptedSessionId,
  loadFailureMessage,
  isBookmarked,
  onToggleBookmark,
  onRetry,
}: DetailLandingProps) {
  const { recentSessions, totalMessages, totalTokens, totalCost, costSource, latestUpdatedAt } =
    useMemo(() => {
      const sortedSessions = sessions.toSorted(
        (a, b) => (b.time_updated || b.time_created || 0) - (a.time_updated || a.time_created || 0),
      );
      let totalMessages = 0;
      let totalTokens = 0;
      let totalCost = 0;
      let hasEstimatedCost = false;
      for (const session of sessions) {
        totalMessages += session.stats.message_count;
        totalTokens += getSessionTotalTokens(session.stats);
        totalCost += session.stats.total_cost;
        hasEstimatedCost ||= session.stats.cost_source === "estimated";
      }
      return {
        recentSessions: sortedSessions.slice(0, 5),
        totalMessages,
        totalTokens,
        totalCost,
        costSource:
          totalCost > 0
            ? hasEstimatedCost
              ? ("estimated" as const)
              : ("recorded" as const)
            : undefined,
        latestUpdatedAt: sortedSessions[0]?.time_updated || sortedSessions[0]?.time_created,
      };
    }, [sessions]);

  if (type === "missing-agent") {
    const requestedPath = `/${attemptedAgentKey || "unknown"}${attemptedSessionId ? `/${attemptedSessionId}` : ""}`;

    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <MissingStateHero
          code="404 / AGENT"
          title="This agent isn't on the roster."
          description="The path you requested is valid in shape, but there is no matching agent in the current registry. It may not be connected yet, or its name may not match what the system recognizes."
          aside="Choose one of the available agents to continue."
        />

        <div className="grid gap-3 md:grid-cols-3">
          <DiagnosticItem label="Requested Agent" value={attemptedAgentKey || "unknown"} />
          <DiagnosticItem label="Requested Path" value={requestedPath} />
          {attemptedSessionId ? (
            <DiagnosticItem label="Requested Session" value={attemptedSessionId} />
          ) : null}
        </div>

        <RecommendedAgents agentItems={agentItems} />
      </div>
    );
  }

  if (type === "missing-session") {
    const agent = activeAgentKey ? findAgent(agentCatalog, activeAgentKey) : undefined;
    const displayName = agent?.displayName ?? activeAgentKey ?? "Unknown Agent";
    const agentIcon = agent?.icon;
    const sessionId = attemptedSessionId || "unknown-session";

    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <MissingStateHero
          code="404 / SESSION"
          title="This session isn't in the index."
          description={`${displayName} is available, but the session you're looking for does not exist in the current index. The session ID may be incorrect, or the record may never have been part of this dataset.`}
          aside="We checked the current path, but nothing matched. The session list on the left is still available."
          iconSrc={agentIcon}
          iconColored={agent?.iconColored}
          iconAlt={displayName}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3">
            <p className="console-eyebrow">Agent</p>
            <div className="mt-2 flex items-center gap-2">
              {agentIcon ? (
                <AgentIcon
                  icon={agentIcon}
                  iconColored={agent?.iconColored}
                  alt={displayName}
                  className="size-4 shrink-0 object-contain"
                />
              ) : null}
              <p className="console-mono break-all text-sm leading-6 text-[var(--console-text)]">
                {displayName}
              </p>
            </div>
          </div>
          <DiagnosticItem label="Session" value={sessionId} />
        </div>

        <RecentSessions
          sessions={recentSessions}
          isBookmarked={isBookmarked}
          onToggleBookmark={onToggleBookmark}
        />
      </div>
    );
  }

  if (type === "load-failed") {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <MissingStateHero
          code="LOAD / SESSION"
          title="We couldn't load this session."
          description="The session request failed before we could determine whether the record exists. It may still be available once the connection or server recovers."
          aside="Retry this request without leaving the current session path."
        />

        <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3">
          <div className="min-w-0 flex-1">
            <DiagnosticItem
              label="Request Error"
              value={loadFailureMessage ?? "Unable to load this session."}
            />
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="console-mono shrink-0 rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-1.5 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            Retry
          </button>
        </div>

        <RecentSessions
          sessions={recentSessions}
          isBookmarked={isBookmarked}
          onToggleBookmark={onToggleBookmark}
        />
      </div>
    );
  }

  if (type === "global") {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <LandingCard label="Total Sessions" value={formatNumber(sessions.length)} />
          <LandingCard label="Total Messages" value={formatNumber(totalMessages)} />
          <LandingCard
            label="Latest Activity"
            value={formatRelativeTime(latestUpdatedAt)}
            hint={latestUpdatedAt ? new Date(latestUpdatedAt).toLocaleString("zh-CN") : undefined}
          />
        </div>

        <Panel className="p-4">
          <PanelHeader title="Agents" meta={`${agentItems.length} items`} />
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {agentItems.map((agent) => (
              <li key={agent.key}>
                <Link
                  to={agentRoutePath(agent.key)}
                  className="flex items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 motion-hover hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                >
                  {agent.icon ? (
                    <AgentIcon
                      icon={agent.icon}
                      iconColored={agent.iconColored}
                      alt={agent.name}
                      className="size-4 object-contain"
                    />
                  ) : null}
                  <span className="console-mono flex-1 text-xs text-[var(--console-text)]">
                    {agent.name}
                  </span>
                  <span className="console-mono text-[11px] text-[var(--console-muted)]">
                    {agent.count}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <RecentSessions
          sessions={recentSessions}
          isBookmarked={isBookmarked}
          onToggleBookmark={onToggleBookmark}
        />
      </div>
    );
  }

  // type === "agent"
  const activeAgent = activeAgentKey ? findAgent(agentCatalog, activeAgentKey) : undefined;
  const displayName = activeAgent?.displayName ?? "Unknown Agent";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Panel className="p-4">
        <div className="flex items-center gap-3">
          {activeAgent?.icon ? (
            <AgentIcon
              icon={activeAgent.icon}
              iconColored={activeAgent.iconColored}
              alt={displayName}
              className="size-6 object-contain"
            />
          ) : null}
          <div>
            <h3 className="console-display text-[15px] font-semibold text-[var(--console-text)]">
              {displayName}
            </h3>
            <p className="console-mono text-xs text-[var(--console-muted)]">
              Select a session from the left to view details
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 md:grid-cols-4">
        <LandingCard label="Sessions" value={formatNumber(sessions.length)} />
        <LandingCard label="Messages" value={formatNumber(totalMessages)} />
        <LandingCard label="Tokens" value={formatNumber(totalTokens)} />
        <LandingCard
          label="Total Cost"
          value={formatMoney(totalCost)}
          hint={formatCostSource(costSource)}
        />
      </div>

      <RecentSessions
        sessions={recentSessions}
        isBookmarked={isBookmarked}
        onToggleBookmark={onToggleBookmark}
      />
    </div>
  );
});
