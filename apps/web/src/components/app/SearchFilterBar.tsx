import type { Dispatch, SetStateAction } from "react";
import type { AgentInfo, FileActivityKind, SmartTag } from "../../lib/api";
import { getProjectIdentityKey } from "../../lib/projects";
import { SMART_TAG_LABELS } from "../SmartTagChips";
import { FilterChip } from "./FilterChip";
import type { CostRangeId, SearchFilterState, SearchProjectOption } from "./types";

export const SMART_TAG_OPTIONS: SmartTag[] = [
  "bugfix",
  "refactoring",
  "feature-dev",
  "testing",
  "docs",
  "git-ops",
  "build-deploy",
  "exploration",
  "planning",
];

export const SEARCH_TOOL_OPTIONS = ["apply_patch", "bash", "read", "edit", "grep"] as const;

export const FILE_ACTIVITY_OPTIONS: Array<{ kind: FileActivityKind; label: string }> = [
  { kind: "read", label: "Read" },
  { kind: "edit", label: "Edit" },
  { kind: "write", label: "Write" },
  { kind: "delete", label: "Delete" },
];

export const COST_RANGE_OPTIONS: Array<{
  id: CostRangeId;
  label: string;
  costMin: number;
}> = [
  { id: "paid", label: "Cost > $0", costMin: 0.000001 },
  { id: "one_plus", label: "Cost >= $1", costMin: 1 },
  { id: "ten_plus", label: "Cost >= $10", costMin: 10 },
];

export function SearchFilterBar({
  agents,
  projects,
  filters,
  onChangeFilters,
}: {
  agents: AgentInfo[];
  projects: SearchProjectOption[];
  filters: SearchFilterState;
  onChangeFilters: Dispatch<SetStateAction<SearchFilterState>>;
}) {
  const hasActiveFilters = Object.values(filters).some(Boolean);
  const selectedProjectKey = filters.project ? getProjectIdentityKey(filters.project) : undefined;
  const setFilter = <K extends keyof SearchFilterState>(key: K, value: SearchFilterState[K]) => {
    onChangeFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white/85 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Scope
        </span>
        <FilterChip
          active={!filters.project}
          label="All"
          onClick={() => onChangeFilters((current) => ({ ...current, project: undefined }))}
        />
        {projects.map((project) => (
          <FilterChip
            key={project.key}
            active={selectedProjectKey === project.key}
            label={
              project.showCount === false ? project.label : `${project.label} · ${project.count}`
            }
            onClick={() =>
              onChangeFilters((current) => ({
                ...current,
                project:
                  selectedProjectKey === project.key
                    ? undefined
                    : { kind: project.identityKind, key: project.identityKey },
              }))
            }
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Agent
        </span>
        <FilterChip
          active={!filters.agent}
          label="All Agents"
          onClick={() => onChangeFilters((current) => ({ ...current, agent: undefined }))}
        />
        {agents.map((agent) => (
          <FilterChip
            key={agent.name}
            active={filters.agent === agent.name}
            label={agent.displayName}
            onClick={() => setFilter("agent", agent.name)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Tag
        </span>
        {SMART_TAG_OPTIONS.map((tag) => (
          <FilterChip
            key={tag}
            active={filters.tag === tag}
            label={SMART_TAG_LABELS[tag]}
            onClick={() => setFilter("tag", tag)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Signal
        </span>
        {SEARCH_TOOL_OPTIONS.map((tool) => (
          <FilterChip
            key={tool}
            active={filters.tool === tool}
            label={`tool:${tool}`}
            onClick={() => setFilter("tool", tool)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          File Activity
        </span>
        {FILE_ACTIVITY_OPTIONS.map((option) => (
          <FilterChip
            key={option.kind}
            active={filters.fileKind === option.kind}
            label={option.label}
            onClick={() => setFilter("fileKind", option.kind)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Cost Range
        </span>
        <FilterChip
          active={!filters.costRange}
          label="Any Cost"
          onClick={() => onChangeFilters((current) => ({ ...current, costRange: undefined }))}
        />
        {COST_RANGE_OPTIONS.map((option) => (
          <FilterChip
            key={option.id}
            active={filters.costRange === option.id}
            label={option.label}
            onClick={() => setFilter("costRange", option.id)}
          />
        ))}
        {hasActiveFilters ? (
          <button
            type="button"
            onClick={() => onChangeFilters({})}
            className="console-mono ml-auto rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[10px] text-[var(--console-muted)] transition-colors hover:bg-white"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
