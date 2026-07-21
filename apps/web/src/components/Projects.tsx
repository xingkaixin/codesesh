import { Link } from "react-router-dom";
import type { DashboardData, ProjectAgentStat, ProjectGroup, SessionHead } from "../lib/api";
import { findAgent, type AgentCatalog } from "../lib/agents";
import { formatMoney, formatNumber, formatRelativeTime } from "../lib/format";
import { getProjectPath } from "../lib/projects";
import { getSessionDisplayTitle } from "../lib/session-title";
import { Dashboard } from "./Dashboard";
import type { LandingSession } from "./DetailLanding";

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatNumber(value);
}

function getSessionTotalTokens(session: SessionHead): number {
  return (
    session.stats.total_tokens ??
    session.stats.total_input_tokens + session.stats.total_output_tokens
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-4">
      <p className="console-mono text-[11px] uppercase tracking-wider text-[var(--console-muted)]">
        {label}
      </p>
      <p className="console-mono mt-2 text-xl font-semibold text-[var(--console-text)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--console-muted)]">{hint}</p> : null}
    </div>
  );
}

function AgentPills({
  agents,
  agentCatalog,
}: {
  agents: ProjectAgentStat[];
  agentCatalog: AgentCatalog;
}) {
  if (agents.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {agents.slice(0, 4).map((agent) => {
        const agentInfo = findAgent(agentCatalog, agent.name);
        return (
          <span
            key={agent.name}
            className="console-mono inline-flex items-center gap-1 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]"
          >
            {agentInfo?.icon ? (
              <img
                src={agentInfo.icon}
                alt={agentInfo.displayName}
                className="size-3 object-contain"
              />
            ) : null}
            {agentInfo?.displayName ?? agent.name} · {agent.sessions}
          </span>
        );
      })}
    </div>
  );
}

function ProjectListItem({
  project,
  agentCatalog,
}: {
  project: ProjectGroup;
  agentCatalog: AgentCatalog;
}) {
  return (
    <li>
      <Link
        to={getProjectPath({ kind: project.identityKind, key: project.identityKey })}
        className="block rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)]/85 p-4 motion-hover hover:border-[var(--console-border-strong)] hover:bg-[var(--console-surface)]"
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h2 className="console-mono line-clamp-1 text-sm font-semibold text-[var(--console-text)]">
              {project.displayName}
            </h2>
            <p className="console-mono mt-1 break-all text-[11px] text-[var(--console-muted)]">
              {project.identityKey}
            </p>
          </div>
          <div className="console-mono flex shrink-0 flex-wrap gap-2 text-[11px] text-[var(--console-muted)]">
            <span>{formatNumber(project.sessionCount)} sessions</span>
            <span>{formatCompact(project.tokens)} tokens</span>
            <span>{formatMoney(project.cost)}</span>
            <span>{formatRelativeTime(project.lastActivity)}</span>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <AgentPills agents={project.agentStats} agentCatalog={agentCatalog} />
          <span className="console-mono text-[10px] uppercase text-[var(--console-muted)]">
            {project.identityKind}
          </span>
        </div>
      </Link>
    </li>
  );
}

export function ProjectsOverview({
  projects,
  agentCatalog,
}: {
  projects: ProjectGroup[];
  agentCatalog: AgentCatalog;
}) {
  const totalSessions = projects.reduce((sum, project) => sum + project.sessionCount, 0);
  const totalTokens = projects.reduce((sum, project) => sum + project.tokens, 0);
  const totalCost = projects.reduce((sum, project) => sum + project.cost, 0);
  const latestActivity = Math.max(0, ...projects.map((project) => project.lastActivity ?? 0));

  if (projects.length === 0) {
    return (
      <div className="mx-auto max-w-5xl rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]">
        No projects found
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="Projects" value={formatNumber(projects.length)} />
        <StatCard label="Sessions" value={formatNumber(totalSessions)} />
        <StatCard label="Tokens" value={formatCompact(totalTokens)} />
        <StatCard
          label="Total Cost"
          value={formatMoney(totalCost)}
          hint={latestActivity ? `Latest ${formatRelativeTime(latestActivity)}` : undefined}
        />
      </div>

      <ul className="grid gap-3">
        {projects.map((project) => (
          <ProjectListItem
            key={`${project.identityKind}:${project.identityKey}`}
            project={project}
            agentCatalog={agentCatalog}
          />
        ))}
      </ul>
    </div>
  );
}

function ProjectAgentFilter({
  agents,
  agentCatalog,
  activeAgent,
  onChange,
}: {
  agents: ProjectAgentStat[];
  agentCatalog: AgentCatalog;
  activeAgent?: string;
  onChange: (agent?: string) => void;
}) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Agent
        </span>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className={`console-mono rounded-sm border px-2 py-1 text-[10px] motion-hover ${
            activeAgent
              ? "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:bg-[var(--console-surface)]"
              : "border-[var(--console-border-strong)] bg-[var(--console-accent)] text-white"
          }`}
        >
          All Agents
        </button>
        {agents.map((agent) => {
          const agentInfo = findAgent(agentCatalog, agent.name);
          const active = activeAgent === agent.name;
          return (
            <button
              key={agent.name}
              type="button"
              onClick={() => onChange(active ? undefined : agent.name)}
              className={`console-mono inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[10px] motion-hover ${
                active
                  ? "border-[var(--console-border-strong)] bg-[var(--console-accent)] text-white"
                  : "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:bg-[var(--console-surface)]"
              }`}
            >
              {agentInfo?.icon ? (
                <img
                  src={agentInfo.icon}
                  alt={agentInfo.displayName}
                  className="size-3 object-contain"
                />
              ) : null}
              {agentInfo?.displayName ?? agent.name} · {agent.sessions}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProjectHeader({
  project,
  agentCatalog,
}: {
  project: ProjectGroup;
  agentCatalog: AgentCatalog;
}) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 className="console-mono text-base font-semibold text-[var(--console-text)]">
            {project.displayName}
          </h2>
          <p className="console-mono mt-1 break-all text-[11px] text-[var(--console-muted)]">
            {project.identityKind}: {project.identityKey}
          </p>
        </div>
        <AgentPills agents={project.agentStats} agentCatalog={agentCatalog} />
      </div>
    </div>
  );
}

function TopCostSessions({
  sessions,
  agentCatalog,
}: {
  sessions: LandingSession[];
  agentCatalog: AgentCatalog;
}) {
  if (sessions.length === 0) return null;

  const topSessions = sessions
    .toSorted((a, b) => b.stats.total_cost - a.stats.total_cost)
    .slice(0, 5);

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
          Top Cost
        </h3>
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {topSessions.length} sessions
        </span>
      </div>
      <ul className="space-y-2">
        {topSessions.map((session) => {
          const agent = findAgent(agentCatalog, session.agentKey);
          return (
            <li key={session.fullPath}>
              <Link
                to={`/${session.fullPath}`}
                className="block rounded-sm border border-transparent px-2 py-1.5 motion-hover hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
              >
                <div className="flex items-center gap-2">
                  {agent?.icon ? (
                    <img
                      src={agent.icon}
                      alt={agent.displayName}
                      className="size-3.5 object-contain"
                    />
                  ) : null}
                  <span className="line-clamp-1 flex-1 text-sm text-[var(--console-text)]">
                    {getSessionDisplayTitle(session)}
                  </span>
                  <span className="console-mono text-[11px] text-[var(--console-muted)]">
                    {formatMoney(session.stats.total_cost)}
                  </span>
                </div>
                <p className="console-mono mt-1 text-[11px] text-[var(--console-muted)]">
                  /{session.fullPath} · {formatCompact(getSessionTotalTokens(session))} tokens
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ProjectDashboardView({
  project,
  agentCatalog,
  projectKey,
  dashboard,
  loading,
  error,
  sessions,
  activeAgent,
  onChangeAgent,
  isBookmarked,
  onToggleSessionBookmark,
}: {
  project: ProjectGroup | null;
  agentCatalog: AgentCatalog;
  projectKey: string;
  dashboard: DashboardData | null;
  loading: boolean;
  error: string | null;
  sessions: LandingSession[];
  activeAgent?: string;
  onChangeAgent: (agent?: string) => void;
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  onToggleSessionBookmark: (session: SessionHead, agentKey: string) => void;
}) {
  if (!project) {
    return (
      <div className="mx-auto max-w-4xl rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-6">
        <h2 className="console-mono text-sm font-semibold text-[var(--console-text)]">
          Project Not Found
        </h2>
        <p className="console-mono mt-2 break-all text-xs text-[var(--console-muted)]">
          {projectKey}
        </p>
        <Link
          to="/projects"
          className="console-mono mt-4 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)]"
        >
          Back to Projects
        </Link>
      </div>
    );
  }

  const scopedSessions = activeAgent
    ? sessions.filter((session) => session.agentKey === activeAgent)
    : sessions;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ProjectHeader project={project} agentCatalog={agentCatalog} />
      <ProjectAgentFilter
        agents={project.agentStats}
        agentCatalog={agentCatalog}
        activeAgent={activeAgent}
        onChange={onChangeAgent}
      />

      {loading ? (
        <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]">
          Loading project dashboard
        </div>
      ) : error ? (
        <div className="rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6 text-sm text-[var(--console-error)]">
          {error}
        </div>
      ) : dashboard ? (
        <Dashboard
          data={dashboard}
          agentCatalog={agentCatalog}
          projects={[]}
          bookmarkedSessions={[]}
          isBookmarked={isBookmarked}
          onToggleBookmark={(session, agentKey) => {
            if ("agentName" in session) {
              onToggleSessionBookmark(session, agentKey ?? session.agentName.toLowerCase());
            }
          }}
        />
      ) : null}

      <TopCostSessions sessions={scopedSessions} agentCatalog={agentCatalog} />
    </div>
  );
}
