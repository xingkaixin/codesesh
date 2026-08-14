import { Link, useNavigate } from "react-router-dom";
import type { ApiProjectAgentStat, ApiProjectGroup, AppConfig } from "../lib/api";
import { findAgent, type AgentCatalog } from "../lib/agents";
import { formatCompact, formatMoney, formatNumber, formatRelativeTime } from "../lib/format";
import { getProjectPath } from "../lib/projects";
import { sessionRoutePath, type IndexedSession } from "../lib/session-indexes";
import type { TimeWindowPreset } from "../lib/time-window";
import { AgentIcon } from "./AgentIcon";
import { OverviewScreen } from "./overview/OverviewScreen";
import { ProjectTimeline } from "./project-timeline/ProjectTimeline";
import { Panel } from "./ui/panel";

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Panel className="p-[14px_16px]">
      <p className="console-eyebrow">{label}</p>
      <p className="console-mono mt-[9px] text-[27px] font-semibold tracking-[-0.02em] text-[var(--console-text)]">
        {value}
      </p>
      {hint ? (
        <p className="console-mono mt-[7px] text-[10.5px] text-[var(--console-muted)]">{hint}</p>
      ) : null}
    </Panel>
  );
}

function AgentPills({
  agents,
  agentCatalog,
}: {
  agents: ApiProjectAgentStat[];
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
              <AgentIcon
                icon={agentInfo.icon}
                iconColored={agentInfo.iconColored}
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
  project: ApiProjectGroup;
  agentCatalog: AgentCatalog;
}) {
  return (
    <li>
      <Link
        to={getProjectPath({ kind: project.identityKind, key: project.identityKey })}
        className="block rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 shadow-[var(--shadow-raised)] motion-hover hover:border-[var(--brand-line)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h2 className="line-clamp-1 text-[13px] font-medium text-[var(--console-text)]">
              {project.displayName}
            </h2>
            <p className="console-mono mt-[5px] break-all text-[10.5px] text-[var(--console-muted)]">
              {project.identityKey}
            </p>
          </div>
          <div className="console-mono flex shrink-0 flex-wrap gap-2 text-[11px] text-[var(--console-text-secondary)]">
            <span>{formatNumber(project.sessionCount)} sessions</span>
            <span>{formatCompact(project.tokens)} tokens</span>
            <span className="text-[var(--brand)]">{formatMoney(project.cost)}</span>
            <span className="text-[var(--console-muted)]">
              {formatRelativeTime(project.lastActivity)}
            </span>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <AgentPills agents={project.agentStats} agentCatalog={agentCatalog} />
          <span className="console-eyebrow">{project.identityKind}</span>
        </div>
      </Link>
    </li>
  );
}

export function ProjectsOverview({
  projects,
  agentCatalog,
}: {
  projects: ApiProjectGroup[];
  agentCatalog: AgentCatalog;
}) {
  const totalSessions = projects.reduce((sum, project) => sum + project.sessionCount, 0);
  const totalTokens = projects.reduce((sum, project) => sum + project.tokens, 0);
  const totalCost = projects.reduce((sum, project) => sum + project.cost, 0);
  const latestActivity = Math.max(0, ...projects.map((project) => project.lastActivity ?? 0));

  if (projects.length === 0) {
    return (
      <Panel className="mx-auto max-w-6xl p-6 text-sm text-[var(--console-muted)]">
        No projects found
      </Panel>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
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
  agents: ApiProjectAgentStat[];
  agentCatalog: AgentCatalog;
  activeAgent?: string;
  onChange: (agent?: string) => void;
}) {
  const pillClass = (active: boolean) =>
    `console-mono inline-flex items-center gap-1 rounded-full border px-[13px] py-[5px] text-[11px] motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
      active
        ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
        : "border-[var(--console-border)] bg-[var(--console-surface)] text-[var(--console-muted)] hover:border-[var(--brand-line)]"
    }`;

  return (
    <Panel className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="console-eyebrow">Agent</span>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className={pillClass(!activeAgent)}
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
              className={pillClass(active)}
            >
              {agentInfo?.icon ? (
                <AgentIcon
                  icon={agentInfo.icon}
                  iconColored={agentInfo.iconColored}
                  alt={agentInfo.displayName}
                  className="size-3 object-contain"
                />
              ) : null}
              {agentInfo?.displayName ?? agent.name} · {agent.sessions}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function ProjectHeader({ project }: { project: ApiProjectGroup }) {
  return (
    <Panel className="p-4">
      <h2 className="console-display text-[19px] font-semibold text-[var(--console-text)]">
        {project.displayName}
      </h2>
      <p className="console-mono mt-1 break-all text-[10.5px] text-[var(--console-muted)]">
        {project.identityKind}: {project.identityKey}
      </p>
    </Panel>
  );
}

export function ProjectDashboardView({
  project,
  agentCatalog,
  projectKey,
  sessions,
  activeAgent,
  onChangeAgent,
  timeWindow,
  rangePreset,
  onRangeChange,
  onSelectCustom,
}: {
  project: ApiProjectGroup | null;
  agentCatalog: AgentCatalog;
  projectKey: string;
  sessions: IndexedSession[];
  activeAgent?: string;
  onChangeAgent: (agent?: string) => void;
  timeWindow: AppConfig["window"] | null;
  rangePreset: TimeWindowPreset;
  onRangeChange: (preset: TimeWindowPreset) => void;
  onSelectCustom: (from: string, to: string) => void;
}) {
  const navigate = useNavigate();

  if (!project) {
    return (
      <Panel className="mx-auto max-w-4xl p-6">
        <h2 className="console-display text-[15px] font-semibold text-[var(--console-text)]">
          Project Not Found
        </h2>
        <p className="console-mono mt-2 break-all text-xs text-[var(--console-muted)]">
          {projectKey}
        </p>
        <Link
          to="/projects"
          className="console-mono mt-4 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          Back to Projects
        </Link>
      </Panel>
    );
  }

  const scopedSessions = activeAgent
    ? sessions.filter((session) => session.agentKey === activeAgent)
    : sessions;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ProjectHeader project={project} />
      <ProjectAgentFilter
        agents={project.agentStats}
        agentCatalog={agentCatalog}
        activeAgent={activeAgent}
        onChange={onChangeAgent}
      />

      <OverviewScreen
        key={`${project.identityKind}:${project.identityKey}`}
        project={{ kind: project.identityKind, key: project.identityKey }}
        agent={activeAgent}
        onAgentChange={onChangeAgent}
        window={timeWindow}
        agentCatalog={agentCatalog}
        rangePreset={rangePreset}
        onRangeChange={onRangeChange}
        onSelectCustom={onSelectCustom}
      />

      <ProjectTimeline
        sessions={scopedSessions}
        projectName={project.displayName}
        agentCatalog={agentCatalog}
        onOpenSession={(reference) => navigate(sessionRoutePath(reference))}
      />
    </div>
  );
}
