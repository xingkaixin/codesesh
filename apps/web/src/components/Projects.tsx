import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { ApiProjectAgentStat, ApiProjectGroup, AppConfig } from "@codesesh/contract";
import {
  useProjectPagination,
  useProjectLookup,
  type ProjectPageLocation,
} from "../hooks/useProjects";
import { findAgent, type AgentCatalog } from "../lib/agents";
import type { DashboardFilters, ProjectSort } from "../lib/api";
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

function parseProjectSort(raw: string | null): ProjectSort {
  return raw === "sessions" || raw === "cost" ? raw : "latest";
}

function windowParamKey(window: AppConfig["window"] | null): string | null {
  if (!window) return null;
  return `${window.days ?? ""}:${window.from ?? ""}:${window.to ?? ""}`;
}

const PAGER_BUTTON_CLASS =
  "rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-1 text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

function SummaryMetric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
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
  window,
  agentCatalog,
  loading,
  error,
  onRetry,
}: {
  window: AppConfig["window"] | null;
  agentCatalog: AgentCatalog;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  useLocale();

  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const savedCursors: unknown = location.state?.projectCursors;
  const previousCursors =
    Array.isArray(savedCursors) && savedCursors.every((value) => typeof value === "string")
      ? savedCursors
      : undefined;
  const sort = parseProjectSort(searchParams.get("sort"));
  const sourceNodeId = searchParams.get("sourceNodeId") || undefined;
  const cursor = searchParams.get("cursor") || undefined;
  const parsedPage = Number.parseInt(searchParams.get("page") ?? "", 10);
  const urlPageNumber =
    cursor && Number.isInteger(parsedPage) && parsedPage > 1 ? parsedPage : undefined;

  const handleSortChange = useCallback(
    (nextSort: ProjectSort) => {
      setSearchParams((current) => {
        const updated = new URLSearchParams(current);
        if (nextSort === "latest") updated.delete("sort");
        else updated.set("sort", nextSort);
        updated.delete("page");
        updated.delete("cursor");
        return updated;
      });
    },
    [setSearchParams],
  );

  const handleSourceNodeChange = useCallback(
    (nextSourceNodeId?: string) => {
      setSearchParams((current) => {
        const updated = new URLSearchParams(current);
        if (nextSourceNodeId) updated.set("sourceNodeId", nextSourceNodeId);
        else updated.delete("sourceNodeId");
        updated.delete("page");
        updated.delete("cursor");
        return updated;
      });
    },
    [setSearchParams],
  );

  const handleNavigatePage = useCallback(
    (next: ProjectPageLocation, options?: { replace?: boolean }) => {
      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next.cursor) {
            updated.set("page", String(next.pageNumber));
            updated.set("cursor", next.cursor);
          } else {
            updated.delete("page");
            updated.delete("cursor");
          }
          return updated;
        },
        { replace: options?.replace, state: { projectCursors: next.previousCursors } },
      );
    },
    [setSearchParams],
  );

  const currentWindowKey = windowParamKey(window);
  const previousWindowKeyRef = useRef<string | null>(currentWindowKey);
  useEffect(() => {
    if (currentWindowKey === null) return;
    if (
      previousWindowKeyRef.current !== null &&
      previousWindowKeyRef.current !== currentWindowKey &&
      (searchParams.has("cursor") || searchParams.has("page"))
    ) {
      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.delete("page");
          updated.delete("cursor");
          return updated;
        },
        { replace: true },
      );
    }
    previousWindowKeyRef.current = currentWindowKey;
  }, [currentWindowKey, searchParams, setSearchParams]);

  const paginationControl = useMemo(
    () => ({
      cursor,
      pageNumber: urlPageNumber,
      previousCursors,
      onNavigate: handleNavigatePage,
    }),
    [cursor, handleNavigatePage, previousCursors, urlPageNumber],
  );
  const pagination = useProjectPagination(window, sourceNodeId, sort, paginationControl);
  const page = pagination.page;
  const currentError = pagination.error ?? error;
  const retry = pagination.error ? () => void pagination.retry() : onRetry;

  if (!page)
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <SourceFilter value={sourceNodeId} onChange={handleSourceNodeChange} />
        {currentError ? (
          <ResourceLoadFailure
            title={t("Couldn't load projects.")}
            message={currentError}
            onRetry={retry}
          />
        ) : (
          <Panel className="p-6 text-sm text-[var(--console-muted)]">
            {t("Loading projects...")}
          </Panel>
        )}
      </div>
    );
  const projects = page.projects.slice(0, 250);
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
      <SourceFilter value={sourceNodeId} onChange={handleSourceNodeChange} />
      {currentError ? (
        <ResourceLoadFailure
          title={t("Couldn't refresh projects.")}
          message={currentError}
          onRetry={retry}
        />
      ) : null}
      <Panel className="grid grid-cols-1 overflow-hidden sm:grid-cols-3">
        <SummaryMetric label={t("Sessions")} value={formatNumber(page.summary.sessions)} />
        <SummaryMetric
          label={t("Tokens")}
          value={formatCompact(page.summary.tokens)}
          className="border-t sm:border-t-0 sm:border-l"
        />
        <SummaryMetric
          label={t("Total Cost")}
          value={formatMoney(page.summary.cost)}
          className="border-t sm:border-t-0 sm:border-l"
        />
      </Panel>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <SegmentedControl
          size="sm"
          ariaLabel={t("Sort projects")}
          value={sort}
          onChange={handleSortChange}
          options={[
            { value: "latest", label: t("Latest Activity") },
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
            {projects.map((project) => {
              const basePath = getProjectPath({
                kind: project.identityKind,
                key: project.identityKey,
              });
              const projectTo = sourceNodeId
                ? `${basePath}?sourceNodeId=${encodeURIComponent(sourceNodeId)}`
                : basePath;
              return (
                <tr
                  key={`${project.identityKind}:${project.identityKey}`}
                  className="border-b border-[var(--console-border)] last:border-b-0 hover:bg-[var(--console-surface-muted)]"
                >
                  <th scope="row" className="max-w-0 px-4 py-2.5 font-normal">
                    <Link
                      to={projectTo}
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
              );
            })}
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

function ProjectHero({
  project,
  agentCatalog,
  activeAgent,
  onChangeAgent,
  sourceNodeId,
  onChangeSourceNode,
}: {
  project: ApiProjectGroup;
  agentCatalog: AgentCatalog;
  activeAgent?: string;
  onChangeAgent: (agent?: string) => void;
  sourceNodeId?: string;
  onChangeSourceNode: (sourceNodeId?: string) => void;
}) {
  useLocale();

  const chipClass = (active: boolean) =>
    cn(
      "motion-hover inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
      active
        ? "border-[var(--brand-line)] bg-[var(--brand-soft)] text-[var(--brand)]"
        : "border-[var(--console-border-strong)] text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]",
    );

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="console-display min-w-0 text-2xl leading-tight font-light break-words text-[var(--console-text)] sm:text-[28px]">
          {project.displayName}
        </h1>
        <p className="console-mono mt-1 break-all text-xs text-[var(--console-muted)]">
          {project.identityKey}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SourceFilter value={sourceNodeId} onChange={onChangeSourceNode} />
        <div role="group" aria-label={t("Filter by agent")} className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={!activeAgent}
            onClick={() => onChangeAgent(undefined)}
            className={chipClass(!activeAgent)}
          >
            {t("All agents")}
          </button>
          {project.agentStats.map((agent) => {
            const agentInfo = findAgent(agentCatalog, agent.name);
            const active = activeAgent === agent.name;
            return (
              <button
                key={agent.name}
                type="button"
                aria-pressed={active}
                onClick={() => onChangeAgent(active ? undefined : agent.name)}
                className={chipClass(active)}
              >
                {agentInfo?.icon ? (
                  <AgentIcon
                    icon={agentInfo.icon}
                    iconColored={agentInfo.iconColored}
                    alt=""
                    className="size-3.5 object-contain"
                  />
                ) : null}
                {agentInfo?.displayName ?? agent.name}
                <span className="console-mono text-[var(--console-muted)]">{agent.sessions}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
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
  onSelectModel,
  timeWindow,
  rangePreset,
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
  onSelectModel?: (model: string, scope: DashboardFilters) => void;
  timeWindow: AppConfig["window"] | null;
  rangePreset: TimeWindowPreset;
}) {
  useLocale();

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceNodeId = searchParams.get("sourceNodeId") || undefined;
  const handleSourceNodeChange = useCallback(
    (nextSourceNodeId?: string) => {
      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (nextSourceNodeId) updated.set("sourceNodeId", nextSourceNodeId);
          else updated.delete("sourceNodeId");
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const scopedProject = useProjectLookup(
    timeWindow,
    sourceNodeId && project ? { kind: project.identityKind, key: project.identityKey } : null,
    [],
    sourceNodeId,
  );

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

  const scopedSessions = sessions.filter((session) => {
    if (activeAgent && session.reference.agentName !== activeAgent) return false;
    if (sourceNodeId && (session.reference.sourceNodeId ?? "local") !== sourceNodeId) {
      return false;
    }
    return true;
  });

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <ProjectHero
        project={
          sourceNodeId
            ? { ...project, agentStats: scopedProject.project?.agentStats ?? [] }
            : project
        }
        agentCatalog={agentCatalog}
        activeAgent={activeAgent}
        onChangeAgent={onChangeAgent}
        sourceNodeId={sourceNodeId}
        onChangeSourceNode={handleSourceNodeChange}
      />

      {scopedProject.error ? (
        <ResourceLoadFailure
          title={t("Couldn't load project.")}
          message={scopedProject.error}
          onRetry={() => void scopedProject.retry()}
        />
      ) : null}
      <OverviewScreen
        key={`${project.identityKind}:${project.identityKey}`}
        project={{ kind: project.identityKind, key: project.identityKey }}
        agent={activeAgent}
        onAgentChange={onChangeAgent}
        sourceNodeId={sourceNodeId}
        onSourceNodeChange={handleSourceNodeChange}
        onSelectModel={onSelectModel}
        window={timeWindow}
        agentCatalog={agentCatalog}
        rangePreset={rangePreset}
      >
        <ProjectTimeline
          key={`${project.identityKind}:${project.identityKey}:${activeAgent ?? "all"}:${sourceNodeId ?? "all"}`}
          sessions={scopedSessions}
          projectName={project.displayName}
          agentCatalog={agentCatalog}
          onOpenSession={(reference) => navigate(sessionRoutePath(reference))}
        />
      </OverviewScreen>
    </div>
  );
}
