import { useState } from "react";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Link, useNavigate } from "react-router-dom";
import type { ApiProjectAgentStat, ApiProjectGroup, ApiProjectPage, AppConfig } from "../lib/api";
import { useProjectPagination } from "../hooks/useProjects";
import { findAgent, type AgentCatalog } from "../lib/agents";
import { formatCompact, formatMoney, formatNumber, formatRelativeTime } from "../lib/format";
import { getProjectPath } from "../lib/projects";
import { sessionRoutePath, type IndexedSession } from "../lib/session-indexes";
import type { TimeWindowPreset } from "../lib/time-window";
import { AgentIcon } from "./AgentIcon";
import { OverviewScreen } from "./overview/OverviewScreen";
import { ProjectTimeline } from "./project-timeline/ProjectTimeline";
import { ResourceLoadFailure } from "./ResourceLoadFailure";
import { Panel } from "./ui/panel";
import { SegmentedControl } from "./ui/segmented-control";
import { cn } from "../lib/utils";
import { SourceFilter } from "./nodes/SourceFilter";

type ProjectSort = "activity" | "sessions" | "cost";

const PAGER_BUTTON_CLASS =
  "rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-1 text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

function SummaryMetric({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 border-[var(--console-border)] px-5 py-4",
        className,
      )}
    >
      <span className="text-xs text-[var(--console-muted)]">{label}</span>
      <span className="console-mono text-[26px] leading-tight font-light text-[var(--console-text)]">
        {value}
      </span>
      {detail ? <span className="text-[11px] text-[var(--console-muted)]">{detail}</span> : null}
    </div>
  );
}

function ProjectAgents({
  agents,
  agentCatalog,
}: {
  agents: ApiProjectAgentStat[];
  agentCatalog: AgentCatalog;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {agents.slice(0, 4).map((agent) => {
        const agentInfo = findAgent(agentCatalog, agent.name);
        const label = `${agentInfo?.displayName ?? agent.name} · ${agent.sessions}`;
        return (
          <span key={agent.name} title={label} className="inline-flex items-center gap-1">
            {agentInfo?.icon ? (
              <AgentIcon
                icon={agentInfo.icon}
                iconColored={agentInfo.iconColored}
                alt=""
                className="size-3.5 object-contain"
              />
            ) : null}
            <span className="sr-only">{label}</span>
            <span aria-hidden className="console-mono text-[11px] text-[var(--console-muted)]">
              {agent.sessions}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function ProjectsOverview({
  initialPage,
  window,
  agentCatalog,
  loading,
  error,
  onRetry,
}: {
  initialPage: ApiProjectPage;
  window: AppConfig["window"] | null;
  agentCatalog: AgentCatalog;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  useLocale();

  const [sourceNodeId, setSourceNodeId] = useState<string>();
  const pagination = useProjectPagination(window, initialPage, sourceNodeId);
  const page = pagination.page ?? initialPage;
  const projects = page.projects.slice(0, 250);
  const [sort, setSort] = useState<ProjectSort>("activity");
  const sorted =
    sort === "sessions"
      ? projects.toSorted((a, b) => b.sessionCount - a.sessionCount)
      : sort === "cost"
        ? projects.toSorted((a, b) => b.cost - a.cost)
        : projects;
  const currentError = pagination.error ?? error;
  const retry = pagination.error ? () => void pagination.retry() : onRetry;

  if (page.summary.projects === 0 && !sourceNodeId) {
    if (currentError) {
      return (
        <div className="mx-auto max-w-6xl">
          <ResourceLoadFailure
            title={t("Couldn't load projects.")}
            message={currentError}
            onRetry={retry}
          />
        </div>
      );
    }
    if (loading || pagination.loading) {
      return (
        <Panel className="mx-auto max-w-6xl p-6 text-sm text-[var(--console-muted)]">
          {t("Loading projects...")}
        </Panel>
      );
    }
    return (
      <Panel className="mx-auto max-w-6xl p-6 text-sm text-[var(--console-muted)]">
        {t("No projects found")}
      </Panel>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SourceFilter value={sourceNodeId} onChange={setSourceNodeId} />
      {currentError ? (
        <ResourceLoadFailure
          title={t("Couldn't refresh projects.")}
          message={currentError}
          onRetry={retry}
        />
      ) : null}
      <Panel className="grid grid-cols-2 overflow-hidden md:grid-cols-4">
        <SummaryMetric label={t("Projects")} value={formatNumber(page.summary.projects)} />
        <SummaryMetric
          label={t("Sessions")}
          value={formatNumber(page.summary.sessions)}
          className="border-l"
        />
        <SummaryMetric
          label={t("Tokens")}
          value={formatCompact(page.summary.tokens)}
          className="border-t md:border-t-0 md:border-l"
        />
        <SummaryMetric
          label={t("Total Cost")}
          value={formatMoney(page.summary.cost)}
          detail={
            page.summary.latestActivity
              ? t("Latest {0}", [formatRelativeTime(page.summary.latestActivity)])
              : undefined
          }
          className="border-t border-l md:border-t-0"
        />
      </Panel>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-[var(--console-muted)]">{t("Sort")}</span>
        <SegmentedControl
          size="sm"
          ariaLabel={t("Sort projects")}
          value={sort}
          onChange={setSort}
          options={[
            { value: "activity", label: t("Latest Activity") },
            { value: "sessions", label: t("Sessions") },
            { value: "cost", label: t("Cost") },
          ]}
        />
      </div>

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <caption className="sr-only">{t("Projects")}</caption>
          <thead>
            <tr className="border-b border-[var(--console-border)] text-[11px] text-[var(--console-muted)]">
              <th scope="col" className="w-2/5 px-4 py-2.5 font-normal">
                {t("Project")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-normal">
                {t("Agents")}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-normal">
                {t("Sessions")}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-normal">
                {t("Tokens")}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-normal">
                {t("Cost")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-normal">
                {t("Latest Activity")}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((project) => (
              <tr
                key={`${project.identityKind}:${project.identityKey}`}
                className="border-b border-[var(--console-border)] last:border-b-0 hover:bg-[var(--console-surface-muted)]"
              >
                <th scope="row" className="max-w-0 px-4 py-2.5 font-normal">
                  <Link
                    to={getProjectPath({ kind: project.identityKind, key: project.identityKey })}
                    className="block truncate text-[13px] font-medium text-[var(--console-text)] hover:text-[var(--brand-ink)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
                  >
                    {project.displayName}
                  </Link>
                  <span className="console-mono block truncate text-[11px] text-[var(--console-muted)]">
                    {project.identityKey}
                  </span>
                </th>
                <td className="px-3 py-2.5">
                  <ProjectAgents agents={project.agentStats} agentCatalog={agentCatalog} />
                </td>
                <td className="console-mono px-3 py-2.5 text-right text-[var(--console-text)]">
                  {formatNumber(project.sessionCount)}
                </td>
                <td className="console-mono px-3 py-2.5 text-right text-[var(--console-text)]">
                  {formatCompact(project.tokens)}
                </td>
                <td className="console-mono px-3 py-2.5 text-right text-[var(--console-text)]">
                  {formatMoney(project.cost)}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-[var(--console-muted)]">
                  {formatRelativeTime(project.lastActivity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="flex items-center justify-between gap-3 text-xs text-[var(--console-muted)]">
        <span>
          {t("Page {0} · {1} shown", [pagination.pageNumber, formatNumber(projects.length)])}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!pagination.canPrevious}
            onClick={pagination.previous}
            className={PAGER_BUTTON_CLASS}
          >
            {t("Previous")}
          </button>
          <button
            type="button"
            disabled={!pagination.canNext}
            onClick={pagination.next}
            className={PAGER_BUTTON_CLASS}
          >
            {t("Next")}
          </button>
        </div>
      </div>
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
  useLocale();

  const pillClass = (active: boolean) =>
    `console-mono inline-flex items-center gap-1 rounded-full border px-[13px] py-[5px] text-[11px] motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
      active
        ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
        : "border-[var(--console-border)] bg-[var(--console-surface)] text-[var(--console-muted)] hover:border-[var(--brand-line)]"
    }`;

  return (
    <Panel className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="console-eyebrow">{t("Agent")}</span>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className={pillClass(!activeAgent)}
        >
          {t("All Agents")}
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
  useLocale();

  return (
    <p className="console-mono break-all text-xs text-[var(--console-muted)]">
      {project.identityKind}: {project.identityKey}
    </p>
  );
}

export function ProjectDashboardView({
  project,
  loading,
  error,
  onRetry,
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
  loading: boolean;
  error: string | null;
  onRetry: () => void;
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
  useLocale();

  const navigate = useNavigate();

  if (loading) {
    return (
      <Panel className="mx-auto max-w-4xl p-6 text-sm text-[var(--console-muted)]">
        {t("Loading project...")}
      </Panel>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <ResourceLoadFailure
          title={t("Couldn't load project.")}
          message={error}
          onRetry={onRetry}
        />
      </div>
    );
  }

  if (!project) {
    return (
      <Panel className="mx-auto max-w-4xl p-6">
        <h2 className="console-display text-[15px] font-semibold text-[var(--console-text)]">
          {t("Project Not Found")}
        </h2>
        <p className="console-mono mt-2 break-all text-xs text-[var(--console-muted)]">
          {projectKey}
        </p>
        <Link
          to="/projects"
          className="console-mono mt-4 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          {t("Back to Projects")}
        </Link>
      </Panel>
    );
  }

  const scopedSessions = activeAgent
    ? sessions.filter((session) => session.reference.agentName === activeAgent)
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
      >
        <ProjectTimeline
          key={`${project.identityKind}:${project.identityKey}:${activeAgent ?? "all"}`}
          sessions={scopedSessions}
          projectName={project.displayName}
          agentCatalog={agentCatalog}
          onOpenSession={(reference) => navigate(sessionRoutePath(reference))}
        />
      </OverviewScreen>
    </div>
  );
}
