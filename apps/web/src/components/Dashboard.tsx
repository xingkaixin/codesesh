import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Pie, PieChart } from "recharts";
import { ModelConfig } from "../config";
import type {
  BookmarkedSessionSnapshot,
  DashboardData,
  DashboardAgentStat,
  DashboardDailyBucket,
  DailyTokenBucket,
  ModelDistributionEntry,
  DashboardRecentSession,
} from "../lib/api";
import { getSessionBookmarkKey } from "../lib/bookmarks";
import { BookmarkButton } from "./BookmarkButton";
import { SmartTagChips } from "./SmartTagChips";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

interface DashboardProps {
  data: DashboardData;
  bookmarkedSessions: BookmarkedSessionSnapshot[];
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  onToggleBookmark: (
    session: DashboardRecentSession | BookmarkedSessionSnapshot,
    agentKey?: string,
  ) => void;
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatNumber(value);
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

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
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

function formatMonthDay(date: string): string {
  // Input: YYYY-MM-DD → Output: MM-DD
  return date.length >= 10 ? date.slice(5) : date;
}

function DailyActivityChart({ buckets }: { buckets: DashboardDailyBucket[] }) {
  const [hovered, setHovered] = useState<DashboardDailyBucket | null>(null);
  const maxValue = useMemo(() => Math.max(1, ...buckets.map((b) => b.sessions)), [buckets]);
  const totalSessions = useMemo(() => buckets.reduce((sum, b) => sum + b.sessions, 0), [buckets]);

  // Evenly-spaced tick indices (up to 6 labels so X-axis stays readable)
  const tickIndices = useMemo(() => {
    if (buckets.length === 0) return new Set<number>();
    const count = Math.min(6, buckets.length);
    if (count === 1) return new Set([0]);
    const set = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      set.add(Math.round((i * (buckets.length - 1)) / (count - 1)));
    }
    return set;
  }, [buckets.length]);

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
            Daily Activity
          </h3>
          <p className="console-mono mt-1 text-[11px] text-[var(--console-muted)]">
            Session activity · last {buckets.length} days
          </p>
        </div>
        <span className="console-mono text-right text-[11px] text-[var(--console-muted)]">
          {hovered
            ? `${hovered.date} · ${formatNumber(hovered.sessions)} sessions · ${formatNumber(hovered.messages)} msgs`
            : `${formatNumber(totalSessions)} in range`}
        </span>
      </div>

      <div className="flex h-32 items-end gap-[2px]" onMouseLeave={() => setHovered(null)}>
        {buckets.map((bucket) => {
          const pxHeight =
            bucket.sessions > 0 ? Math.max(Math.round((bucket.sessions / maxValue) * 128), 4) : 2;
          const title = `${bucket.date} · ${bucket.sessions} sessions · ${bucket.messages} msgs`;
          const isActive = hovered?.date === bucket.date;
          return (
            <div
              key={bucket.date}
              title={title}
              onMouseEnter={() => setHovered(bucket)}
              className={`flex-1 cursor-default rounded-t-[1px] transition-opacity ${
                bucket.sessions > 0
                  ? "bg-[var(--console-accent)]"
                  : "bg-[var(--console-surface-muted)]"
              } ${isActive ? "opacity-70" : "opacity-100"}`}
              style={{ height: `${pxHeight}px` }}
            />
          );
        })}
      </div>

      <div className="console-mono mt-2 flex text-[10px] text-[var(--console-muted)]">
        {buckets.map((bucket, i) => (
          <span key={bucket.date} className="flex-1 text-center">
            {tickIndices.has(i) ? formatMonthDay(bucket.date) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const TOKEN_COLORS = {
  input: "#4A9EFF",
  output: "#7C5CFF",
  cache_read: "#3FB68B",
  cache_create: "#E8A23B",
} as const;

const TOKEN_LABELS: Record<string, string> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache Read",
  cache_create: "Cache Create",
};

function DailyTokenChart({ buckets }: { buckets: DailyTokenBucket[] }) {
  const [hovered, setHovered] = useState<DailyTokenBucket | null>(null);

  const maxValue = useMemo(
    () => Math.max(1, ...buckets.map((b) => b.input + b.output + b.cache_read + b.cache_create)),
    [buckets],
  );

  const totalTokens = useMemo(
    () => buckets.reduce((sum, b) => sum + b.input + b.output + b.cache_read + b.cache_create, 0),
    [buckets],
  );

  const tickIndices = useMemo(() => {
    if (buckets.length === 0) return new Set<number>();
    const count = Math.min(6, buckets.length);
    if (count === 1) return new Set([0]);
    const set = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      set.add(Math.round((i * (buckets.length - 1)) / (count - 1)));
    }
    return set;
  }, [buckets.length]);

  if (totalTokens === 0) return null;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
            Daily Token Activity
          </h3>
          <p className="console-mono mt-1 text-[11px] text-[var(--console-muted)]">
            Token breakdown · last {buckets.length} days
          </p>
        </div>
        <span className="console-mono text-right text-[11px] text-[var(--console-muted)]">
          {hovered
            ? `${hovered.date} · ${formatCompact(hovered.input + hovered.output + hovered.cache_read + hovered.cache_create)} total`
            : `${formatCompact(totalTokens)} in range`}
        </span>
      </div>

      {hovered ? (
        <div className="mb-2 flex gap-4">
          {(["input", "output", "cache_read", "cache_create"] as const).map((key) => (
            <span
              key={key}
              className="console-mono flex items-center gap-1.5 text-[10px] text-[var(--console-muted)]"
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: TOKEN_COLORS[key] }}
              />
              {TOKEN_LABELS[key]}: {formatCompact(hovered[key])}
            </span>
          ))}
        </div>
      ) : (
        <div className="mb-2 flex gap-4">
          {(["input", "output", "cache_read", "cache_create"] as const).map((key) => (
            <span
              key={key}
              className="console-mono flex items-center gap-1.5 text-[10px] text-[var(--console-muted)]"
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: TOKEN_COLORS[key] }}
              />
              {TOKEN_LABELS[key]}
            </span>
          ))}
        </div>
      )}

      <div className="flex h-32 items-end gap-[2px]" onMouseLeave={() => setHovered(null)}>
        {buckets.map((bucket) => {
          const total = bucket.input + bucket.output + bucket.cache_read + bucket.cache_create;
          const pxHeight = total > 0 ? Math.max(Math.round((total / maxValue) * 128), 4) : 2;
          const isActive = hovered?.date === bucket.date;

          const segments =
            total > 0
              ? ([
                  { key: "input", value: bucket.input },
                  { key: "output", value: bucket.output },
                  { key: "cache_read", value: bucket.cache_read },
                  { key: "cache_create", value: bucket.cache_create },
                ] as const)
              : [];

          return (
            <div
              key={bucket.date}
              onMouseEnter={() => setHovered(bucket)}
              className={`flex flex-1 cursor-default flex-col justify-end overflow-hidden rounded-t-[1px] transition-opacity ${
                isActive ? "opacity-70" : "opacity-100"
              }`}
              style={{ height: `${pxHeight}px` }}
            >
              {total > 0 ? (
                segments.map((seg) => {
                  const segPx = Math.max(Math.round((seg.value / total) * pxHeight), 0);
                  if (segPx === 0) return null;
                  return (
                    <div
                      key={seg.key}
                      style={{
                        height: `${segPx}px`,
                        backgroundColor: TOKEN_COLORS[seg.key as keyof typeof TOKEN_COLORS],
                      }}
                    />
                  );
                })
              ) : (
                <div className="h-full bg-[var(--console-surface-muted)]" />
              )}
            </div>
          );
        })}
      </div>

      <div className="console-mono mt-2 flex text-[10px] text-[var(--console-muted)]">
        {buckets.map((bucket, i) => (
          <span key={bucket.date} className="flex-1 text-center">
            {tickIndices.has(i) ? formatMonthDay(bucket.date) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const MODEL_COLORS = [
  "#4A9EFF",
  "#7C5CFF",
  "#3FB68B",
  "#E8A23B",
  "#E5484D",
  "#5BCEDA",
  "#F472B6",
  "#A78BFA",
  "#FB923C",
  "#6EE7B7",
];

function ModelDistribution({ entries }: { entries: ModelDistributionEntry[] }) {
  const totalTokens = useMemo(() => entries.reduce((sum, e) => sum + e.tokens, 0), [entries]);

  if (entries.length === 0 || totalTokens === 0) {
    return (
      <div className="rounded-sm border border-[var(--console-border)] bg-white p-4 text-sm text-[var(--console-muted)]">
        No model data yet
      </div>
    );
  }

  const chartData = entries.map((entry, i) => ({
    ...entry,
    chartKey: `model${i}`,
    fraction: entry.tokens / totalTokens,
    fill: MODEL_COLORS[i % MODEL_COLORS.length]!,
  }));

  const chartConfig = chartData.reduce<ChartConfig>((config, entry) => {
    config[entry.chartKey] = {
      label: entry.model,
      color: entry.fill,
    };
    return config;
  }, {});

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
          Model Distribution
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {entries.length} models
        </span>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex shrink-0 flex-col items-center">
          <ChartContainer config={chartConfig} className="aspect-square size-[160px]">
            <PieChart>
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    hideLabel
                    nameKey="chartKey"
                    formatter={(value) => (
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        {formatNumber(Number(value))} tokens
                      </span>
                    )}
                  />
                }
              />
              <Pie
                data={chartData}
                dataKey="tokens"
                nameKey="chartKey"
                outerRadius={70}
                paddingAngle={1}
                strokeWidth={0}
                isAnimationActive={false}
              />
            </PieChart>
          </ChartContainer>
          <div className="console-mono -mt-1 text-center">
            <div className="text-xs font-semibold text-[var(--console-text)]">
              {formatCompact(totalTokens)}
            </div>
            <div className="text-[10px] text-[var(--console-muted)]">tokens</div>
          </div>
        </div>

        <ul className="min-w-0 flex-1 space-y-1.5">
          {chartData.map((entry) => (
            <li key={entry.model} className="flex items-center gap-2">
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: entry.fill }}
              />
              <span className="console-mono min-w-0 flex-1 truncate text-xs text-[var(--console-text)]">
                {entry.model}
              </span>
              <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
                {(entry.fraction * 100).toFixed(1)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AgentDistribution({ perAgent }: { perAgent: DashboardAgentStat[] }) {
  const total = useMemo(() => perAgent.reduce((sum, a) => sum + a.sessions, 0), [perAgent]);

  if (total === 0 || perAgent.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--console-border)] bg-white p-4 text-sm text-[var(--console-muted)]">
        No agent data yet
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
          Agent Distribution
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {perAgent.length} agents
        </span>
      </div>

      <ul className="space-y-2">
        {perAgent.map((agent) => {
          const pct = total > 0 ? (agent.sessions / total) * 100 : 0;
          return (
            <li key={agent.name}>
              <Link
                to={`/${agent.name.toLowerCase()}`}
                className="block rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
              >
                <div className="flex items-center gap-2">
                  {agent.icon ? (
                    <img
                      src={agent.icon}
                      alt={agent.displayName}
                      className="size-4 object-contain"
                    />
                  ) : null}
                  <span className="console-mono flex-1 text-xs text-[var(--console-text)]">
                    {agent.displayName}
                  </span>
                  <span className="console-mono text-[11px] text-[var(--console-muted)]">
                    {formatNumber(agent.sessions)} · {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-[var(--console-surface-muted)]">
                  <div className="h-full bg-[var(--console-accent)]" style={{ width: `${pct}%` }} />
                </div>
                <div className="console-mono mt-1 flex gap-3 text-[10px] text-[var(--console-muted)]">
                  <span>{formatNumber(agent.messages)} msgs</span>
                  <span>{formatCompact(agent.tokens)} tokens</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BookmarkedSessions({
  sessions,
  onToggleBookmark,
}: {
  sessions: BookmarkedSessionSnapshot[];
  onToggleBookmark: (session: BookmarkedSessionSnapshot) => void;
}) {
  if (sessions.length === 0) return null;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
          Bookmarked Sessions
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {sessions.length} items
        </span>
      </div>
      <ul className="space-y-2">
        {sessions.map((session) => {
          const agentConfig = ModelConfig.agents[session.agentKey];
          const updated = session.time_updated ?? session.time_created;
          return (
            <li key={getSessionBookmarkKey(session.agentKey, session.sessionId)}>
              <div className="flex items-start gap-2 rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]">
                <Link to={`/${session.fullPath}`} className="flex min-w-0 flex-1 items-start gap-2">
                  {agentConfig?.icon ? (
                    <img
                      src={agentConfig.icon}
                      alt={agentConfig.name}
                      className="mt-0.5 size-3.5 shrink-0 object-contain"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm text-[var(--console-text)]">
                      {session.title}
                    </p>
                    <p className="console-mono mt-0.5 line-clamp-1 text-[11px] text-[var(--console-muted)]">
                      /{session.fullPath} · {formatRelativeTime(updated)}
                    </p>
                  </div>
                </Link>
                <BookmarkButton active onToggle={() => onToggleBookmark(session)} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecentSessions({
  sessions,
  isBookmarked,
  onToggleBookmark,
}: {
  sessions: DashboardRecentSession[];
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  onToggleBookmark: (session: DashboardRecentSession, agentKey: string) => void;
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
          Recent Activity
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {sessions.length} items
        </span>
      </div>
      <ul className="space-y-2">
        {sessions.map((session) => {
          const agentKey = session.agentName.toLowerCase();
          const agentConfig = ModelConfig.agents[agentKey];
          const updated = session.time_updated ?? session.time_created;
          const bookmarked = isBookmarked(agentKey, session.id);
          return (
            <li key={session.id}>
              <div className="flex items-start gap-2 rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]">
                <Link to={`/${session.slug}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {agentConfig?.icon ? (
                      <img
                        src={agentConfig.icon}
                        alt={agentConfig.name}
                        className="size-3.5 shrink-0 object-contain"
                      />
                    ) : null}
                    <p className="line-clamp-1 flex-1 text-sm text-[var(--console-text)]">
                      {session.title}
                    </p>
                    <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
                      {formatRelativeTime(updated)}
                    </span>
                  </div>
                  <p className="console-mono mt-0.5 line-clamp-1 text-[11px] text-[var(--console-muted)]">
                    /{session.slug}
                  </p>
                  <SmartTagChips tags={session.smart_tags} className="mt-1.5" />
                </Link>
                <BookmarkButton
                  active={bookmarked}
                  onToggle={() => onToggleBookmark(session, agentKey)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Dashboard({
  data,
  bookmarkedSessions,
  isBookmarked,
  onToggleBookmark,
}: DashboardProps) {
  const { totals, perAgent, dailyActivity, dailyTokenActivity, modelDistribution, recentSessions } =
    data;

  return (
    <div data-testid="dashboard" className="mx-auto max-w-5xl space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="Total Sessions" value={formatNumber(totals.sessions)} />
        <StatCard label="Total Messages" value={formatNumber(totals.messages)} />
        <StatCard label="Total Tokens" value={formatCompact(totals.tokens)} />
        <StatCard
          label="Latest Activity"
          value={formatRelativeTime(totals.latestActivity)}
          hint={
            totals.latestActivity
              ? new Date(totals.latestActivity).toLocaleString("zh-CN")
              : undefined
          }
        />
      </div>

      <DailyActivityChart buckets={dailyActivity} />
      <DailyTokenChart buckets={dailyTokenActivity} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ModelDistribution entries={modelDistribution} />
        <AgentDistribution perAgent={perAgent} />
      </div>

      <RecentSessions
        sessions={recentSessions}
        isBookmarked={isBookmarked}
        onToggleBookmark={onToggleBookmark}
      />

      <BookmarkedSessions
        sessions={bookmarkedSessions}
        onToggleBookmark={(session) => onToggleBookmark(session)}
      />
    </div>
  );
}
