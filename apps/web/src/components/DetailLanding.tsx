import { Link } from "react-router-dom";
import { ModelConfig } from "../config";
import type { SessionHead } from "../lib/api";
import { BookmarkButton } from "./BookmarkButton";
import { SmartTagChips } from "./SmartTagChips";

export interface LandingSession extends SessionHead {
  agentKey: string;
  sessionSlug: string;
  fullPath: string;
}

export interface LandingAgentItem {
  key: string;
  name: string;
  icon: string;
  count: number;
}

interface DetailLandingProps {
  type: "global" | "agent" | "missing-agent" | "missing-session";
  sessions: LandingSession[];
  agentItems: LandingAgentItem[];
  activeAgentKey?: string;
  attemptedAgentKey?: string;
  attemptedSessionSlug?: string | null;
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  onToggleBookmark: (session: LandingSession) => void;
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

function getSessionTotalTokens(stats: SessionHead["stats"]) {
  return stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
}

function formatRelativeTime(timestamp?: number) {
  if (!timestamp) return "unknown";
  const diff = Date.now() - timestamp;
  if (Number.isNaN(diff) || diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function LandingCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <p className="console-mono text-[11px] uppercase tracking-wider text-[var(--console-muted)]">
        {label}
      </p>
      <p className="console-mono mt-2 text-xl font-semibold text-[var(--console-text)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--console-muted)]">{hint}</p> : null}
    </div>
  );
}

function DiagnosticItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3">
      <p className="console-mono text-[11px] uppercase tracking-wider text-[var(--console-muted)]">
        {label}
      </p>
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
  iconAlt,
}: {
  code: string;
  title: string;
  description: string;
  aside: string;
  iconSrc?: string;
  iconAlt?: string;
}) {
  return (
    <div className="rounded-sm border border-[var(--console-border-strong)] bg-white p-5 md:p-6">
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div className="max-w-2xl">
          <span className="console-mono inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--console-muted)]">
            {code}
          </span>
          <div className="mt-4 flex items-start gap-3">
            {iconSrc ? (
              <img
                src={iconSrc}
                alt={iconAlt || ""}
                className="mt-1 size-8 shrink-0 object-contain"
              />
            ) : null}
            <h2 className="console-mono text-2xl leading-tight font-semibold tracking-tight text-[var(--console-text)] md:text-[2rem]">
              {title}
            </h2>
          </div>
          <p className="mt-3 max-w-[42rem] text-sm leading-7 text-[var(--console-muted)]">
            {description}
          </p>
        </div>
        <div className="min-w-0 rounded-sm border border-dashed border-[var(--console-border)] bg-[var(--console-surface-muted)] px-4 py-3 md:max-w-xs">
          <p className="console-mono text-[11px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
            STATUS NOTE
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--console-text)]">{aside}</p>
        </div>
      </div>
    </div>
  );
}

function RecommendedAgents({ agentItems }: { agentItems: LandingAgentItem[] }) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
          Known Agents
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {agentItems.length} items
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {agentItems.map((agent) => (
          <li key={agent.key}>
            <Link
              to={`/${agent.key}`}
              className="flex min-h-11 items-center gap-2 rounded-sm border border-transparent px-3 py-2 transition-colors duration-200 hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--console-accent)]"
            >
              <img src={agent.icon} alt={agent.name} className="size-4 object-contain" />
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
    </div>
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
    return (
      <div className="rounded-sm border border-[var(--console-border)] bg-white p-4 text-sm text-[var(--console-muted)]">
        No sessions yet
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
          Recent Sessions
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {sessions.length} items
        </span>
      </div>
      <ul className="space-y-2">
        {sessions.map((session) => {
          const bookmarked = isBookmarked(session.agentKey, session.id);
          return (
            <li key={session.id}>
              <div className="flex items-start gap-2 rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]">
                <Link to={`/${session.fullPath}`} className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm text-[var(--console-text)]">{session.title}</p>
                  <p className="console-mono mt-0.5 text-[11px] text-[var(--console-muted)]">
                    /{session.fullPath} ·{" "}
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
    </div>
  );
}

export function DetailLanding({
  type,
  sessions,
  agentItems,
  activeAgentKey,
  attemptedAgentKey,
  attemptedSessionSlug,
  isBookmarked,
  onToggleBookmark,
}: DetailLandingProps) {
  const sortedSessions = sessions.toSorted(
    (a, b) => (b.time_updated || b.time_created || 0) - (a.time_updated || a.time_created || 0),
  );
  const recentSessions = sortedSessions.slice(0, 5);

  const totalMessages = sessions.reduce((sum, item) => sum + item.stats.message_count, 0);
  const totalTokens = sessions.reduce((sum, item) => sum + getSessionTotalTokens(item.stats), 0);
  const latestUpdatedAt = sortedSessions[0]?.time_updated || sortedSessions[0]?.time_created;

  if (type === "missing-agent") {
    const requestedPath = `/${attemptedAgentKey || "unknown"}${attemptedSessionSlug ? `/${attemptedSessionSlug}` : ""}`;

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
          {attemptedSessionSlug ? (
            <DiagnosticItem label="Requested Session" value={attemptedSessionSlug} />
          ) : null}
        </div>

        <RecommendedAgents agentItems={agentItems} />
      </div>
    );
  }

  if (type === "missing-session") {
    const safeAgentKey = activeAgentKey || ModelConfig.getDefaultAgentKey() || "claudecode";
    const agent = ModelConfig.agents[safeAgentKey];
    const displayName = agent?.name || safeAgentKey;
    const agentIcon = agent?.icon;
    const sessionSlug = attemptedSessionSlug || "unknown-session";

    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <MissingStateHero
          code="404 / SESSION"
          title="This session isn't in the index."
          description={`${displayName} is available, but the session you're looking for does not exist in the current index. The slug may be incorrect, or the record may never have been part of this dataset.`}
          aside="We checked the current path, but nothing matched. The session list on the left is still available."
          iconSrc={agentIcon}
          iconAlt={displayName}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3">
            <p className="console-mono text-[11px] uppercase tracking-wider text-[var(--console-muted)]">
              Agent
            </p>
            <div className="mt-2 flex items-center gap-2">
              {agentIcon ? (
                <img src={agentIcon} alt={displayName} className="size-4 shrink-0 object-contain" />
              ) : null}
              <p className="console-mono break-all text-sm leading-6 text-[var(--console-text)]">
                {displayName}
              </p>
            </div>
          </div>
          <DiagnosticItem label="Session" value={sessionSlug} />
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

        <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
          <h3 className="console-mono mb-3 text-xs font-bold uppercase text-[var(--console-text)]">
            Agents
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {agentItems.map((agent) => (
              <li key={agent.key}>
                <Link
                  to={`/${agent.key}`}
                  className="flex items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                >
                  <img src={agent.icon} alt={agent.name} className="size-4 object-contain" />
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
        </div>

        <RecentSessions
          sessions={recentSessions}
          isBookmarked={isBookmarked}
          onToggleBookmark={onToggleBookmark}
        />
      </div>
    );
  }

  // type === "agent"
  const activeAgent = activeAgentKey ? ModelConfig.agents[activeAgentKey] : null;
  const displayName = activeAgent ? activeAgent.name : "Unknown Agent";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
        <div className="flex items-center gap-3">
          {activeAgent ? (
            <img src={activeAgent.icon} alt={displayName} className="size-6 object-contain" />
          ) : null}
          <div>
            <h3 className="console-mono text-sm font-semibold text-[var(--console-text)]">
              {displayName}
            </h3>
            <p className="console-mono text-xs text-[var(--console-muted)]">
              Select a session from the left to view details
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <LandingCard label="Sessions" value={formatNumber(sessions.length)} />
        <LandingCard label="Messages" value={formatNumber(totalMessages)} />
        <LandingCard label="Tokens" value={formatNumber(totalTokens)} />
      </div>

      <RecentSessions
        sessions={recentSessions}
        isBookmarked={isBookmarked}
        onToggleBookmark={onToggleBookmark}
      />
    </div>
  );
}
