/**
 * Scope switcher + entity picker + range pills. Purely presentational: the scope
 * lives in OverviewScreen, the time window lives in App's time-window controller.
 */
import type { AgentCatalog } from "../../lib/agents";
import type { ApiProjectGroup, DashboardScope } from "../../lib/api";
import type { TimeWindowPreset } from "../../lib/time-window";
import { cn } from "../../lib/utils";
import { SegmentedControl } from "../ui/segmented-control";
import { OVERVIEW_RANGE_PRESETS } from "./types";

const SCOPE_OPTIONS = [
  { value: "global", label: "全局" },
  { value: "project", label: "按项目" },
  { value: "agent", label: "按 Agent" },
] as const;

function projectOptionValue(project: { identityKind: string; identityKey: string }): string {
  return `${project.identityKind}:${project.identityKey}`;
}

export function OverviewFilterBar({
  scope,
  onScopeChange,
  projects,
  agentCatalog,
  scopeCounts,
  rangePreset,
  onRangeChange,
}: {
  scope: DashboardScope;
  onScopeChange: (scope: DashboardScope) => void;
  projects: ApiProjectGroup[];
  agentCatalog: AgentCatalog;
  scopeCounts?: { projects: number; agents: number };
  rangePreset: TimeWindowPreset | null;
  onRangeChange: (preset: TimeWindowPreset) => void;
}) {
  const agents = agentCatalog.active;

  const selectScopeKind = (kind: (typeof SCOPE_OPTIONS)[number]["value"]) => {
    if (kind === scope.kind) return;
    if (kind === "global") {
      onScopeChange({ kind: "global" });
      return;
    }
    if (kind === "project") {
      const first = projects[0];
      if (first) {
        onScopeChange({
          kind: "project",
          projectKind: first.identityKind,
          projectKey: first.identityKey,
        });
      }
      return;
    }
    const firstAgent = agents[0];
    if (firstAgent) onScopeChange({ kind: "agent", agentKey: firstAgent.name.toLowerCase() });
  };

  const selectProject = (value: string) => {
    const project = projects.find((candidate) => projectOptionValue(candidate) === value);
    if (project) {
      onScopeChange({
        kind: "project",
        projectKind: project.identityKind,
        projectKey: project.identityKey,
      });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl
        options={SCOPE_OPTIONS}
        value={scope.kind}
        onChange={selectScopeKind}
        size="md"
        ariaLabel="统计范围"
      />

      {scope.kind === "project" ? (
        <select
          aria-label="选择项目"
          value={`${scope.projectKind}:${scope.projectKey}`}
          onChange={(event) => selectProject(event.target.value)}
          className="console-mono max-w-[220px] rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1.5 text-xs text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          {projects.map((project) => (
            <option key={projectOptionValue(project)} value={projectOptionValue(project)}>
              {project.displayName}
            </option>
          ))}
        </select>
      ) : null}

      {scope.kind === "agent" ? (
        <select
          aria-label="选择 Agent"
          value={scope.agentKey}
          onChange={(event) => onScopeChange({ kind: "agent", agentKey: event.target.value })}
          className="console-mono max-w-[220px] rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1.5 text-xs text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          {agents.map((agent) => (
            <option key={agent.name} value={agent.name.toLowerCase()}>
              {agent.displayName}
            </option>
          ))}
        </select>
      ) : null}

      {scopeCounts ? (
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          范围内 {scopeCounts.projects} 项目 · {scopeCounts.agents} agent
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        {OVERVIEW_RANGE_PRESETS.map((preset) => {
          const selected = preset.value === rangePreset;
          // 自定义 needs the TimeWindowControl dialog, which this screen does not own.
          const disabled = preset.value === "custom";
          return (
            <button
              key={preset.value}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onRangeChange(preset.value)}
              className={cn(
                "console-mono motion-hover rounded-full border px-[13px] py-[5px] text-[11px] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
                selected
                  ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-[var(--console-border)] bg-[var(--console-surface)] text-[var(--console-muted)]",
                disabled && !selected ? "opacity-50" : null,
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
