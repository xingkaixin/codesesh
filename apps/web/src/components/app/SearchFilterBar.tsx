import { SourceFilter } from "../nodes/SourceFilter";
import { useLocale } from "../../hooks/useLocale";
import { useNodes } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { AgentInfo, FileActivityKind } from "@codesesh/contract";
import { SMART_TAGS } from "@codesesh/contract";
import { getProjectIdentityKey } from "../../lib/projects";
import { AgentIcon } from "../AgentIcon";
import { Panel } from "../ui/panel";
import { FilterChip } from "./FilterChip";
import { COST_RANGE_OPTIONS } from "../../lib/search";
import type { SearchFilterState, SearchProjectOption } from "./types";

export const SEARCH_TOOL_OPTIONS = ["apply_patch", "bash", "read", "edit", "grep"] as const;

export const FILE_ACTIVITY_OPTIONS: Array<{ kind: FileActivityKind; label: string }> = [
  { kind: "read", label: "Read" },
  { kind: "edit", label: "Edit" },
  { kind: "write", label: "Write" },
  { kind: "delete", label: "Delete" },
];

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
      <span className="pt-[5px] text-[11px] text-[var(--console-muted)]">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function SearchFilterBar({
  id,
  agents,
  projects,
  filters,
  onChangeFilters,
}: {
  id?: string;
  agents: AgentInfo[];
  projects: SearchProjectOption[];
  filters: SearchFilterState;
  onChangeFilters: Dispatch<SetStateAction<SearchFilterState>>;
}) {
  useLocale();
  const nodes = useNodes();

  const activeCount = Object.values(filters).filter(Boolean).length;
  const selectedProjectKey = filters.project ? getProjectIdentityKey(filters.project) : undefined;
  const setFilter = <K extends keyof SearchFilterState>(key: K, value: SearchFilterState[K]) => {
    onChangeFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  return (
    <Panel id={id} aria-label={t("Search filters")} className="overflow-hidden">
      <div className="flex flex-col gap-2.5 px-[18px] py-4">
        {nodes.data ? (
          <FilterRow label={t("Source")}>
            <SourceFilter
              value={filters.sourceNodeId}
              onChange={(sourceNodeId) =>
                onChangeFilters((current) => ({ ...current, sourceNodeId }))
              }
            />
          </FilterRow>
        ) : null}
        <FilterRow label={t("Project")}>
          <FilterChip
            active={!filters.project}
            onClick={() => onChangeFilters((current) => ({ ...current, project: undefined }))}
          >
            {t("All")}
          </FilterChip>
          {projects.map((project) => (
            <FilterChip
              key={project.key}
              active={selectedProjectKey === project.key}
              mono
              onClick={() =>
                onChangeFilters((current) => ({
                  ...current,
                  project:
                    selectedProjectKey === project.key
                      ? undefined
                      : { kind: project.identityKind, key: project.identityKey },
                }))
              }
            >
              {project.label}
              {project.showCount === false ? null : (
                <span className="opacity-70">{project.count}</span>
              )}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t("Agent")}>
          <FilterChip
            active={!filters.agent}
            onClick={() => onChangeFilters((current) => ({ ...current, agent: undefined }))}
          >
            {t("All Agents")}
          </FilterChip>
          {agents.map((agent) => (
            <FilterChip
              key={agent.name}
              active={filters.agent === agent.name}
              onClick={() => setFilter("agent", agent.name)}
            >
              {agent.icon ? (
                <AgentIcon
                  icon={agent.icon}
                  iconColored={agent.iconColored}
                  alt=""
                  className="size-3.5 shrink-0 object-contain"
                />
              ) : null}
              {agent.displayName}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t("Tag")}>
          {SMART_TAGS.map((tag) => (
            <FilterChip
              key={tag}
              active={filters.tag === tag}
              onClick={() => setFilter("tag", tag)}
            >
              {t(tag)}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t("Signal")}>
          {SEARCH_TOOL_OPTIONS.map((tool) => (
            <FilterChip
              key={tool}
              active={filters.tool === tool}
              mono
              onClick={() => setFilter("tool", tool)}
            >
              tool:{tool}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t("File Activity")}>
          {FILE_ACTIVITY_OPTIONS.map((option) => (
            <FilterChip
              key={option.kind}
              active={filters.fileKind === option.kind}
              onClick={() => setFilter("fileKind", option.kind)}
            >
              {t(option.label)}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t("Cost Range")}>
          <FilterChip
            active={!filters.costRange}
            onClick={() => onChangeFilters((current) => ({ ...current, costRange: undefined }))}
          >
            {t("Any Cost")}
          </FilterChip>
          {COST_RANGE_OPTIONS.map((option) => (
            <FilterChip
              key={option.id}
              active={filters.costRange === option.id}
              onClick={() => setFilter("costRange", option.id)}
            >
              {t(option.label)}
            </FilterChip>
          ))}
        </FilterRow>
      </div>
      {activeCount > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--console-border)] px-[18px] py-3">
          <span className="text-xs text-[var(--console-muted)]">
            {t("{0} filters", [activeCount])}
          </span>
          <button
            type="button"
            onClick={() => onChangeFilters({})}
            className="inline-flex h-6 items-center rounded-md px-2 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            {t("Clear")}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}
