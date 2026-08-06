/**
 * Agent filter + range pills for 统计总览.
 *
 * Which project the dashboard covers is decided by navigation (the sidebar),
 * not by a control inside the page — so there is no scope switcher here. The
 * project dashboard mounts this bar without the agent picker, because the
 * project page already owns one that also filters its timeline.
 */
import type { AgentCatalog } from "../../lib/agents";
import type { TimeWindowPreset } from "../../lib/time-window";
import { cn } from "../../lib/utils";
import { OVERVIEW_RANGE_PRESETS } from "./types";

const ALL_AGENTS = "__all__";

export function OverviewFilterBar({
  agent,
  onAgentChange,
  agentCatalog,
  scopeCounts,
  rangePreset,
  onRangeChange,
}: {
  agent?: string;
  onAgentChange?: (agent?: string) => void;
  agentCatalog: AgentCatalog;
  scopeCounts?: { projects: number; agents: number };
  rangePreset: TimeWindowPreset | null;
  onRangeChange: (preset: TimeWindowPreset) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {onAgentChange ? (
        <select
          aria-label="按 Agent 筛选"
          value={agent ?? ALL_AGENTS}
          onChange={(event) =>
            onAgentChange(event.target.value === ALL_AGENTS ? undefined : event.target.value)
          }
          className="console-mono max-w-[220px] rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1.5 text-xs text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          <option value={ALL_AGENTS}>全部 Agent</option>
          {agentCatalog.active.map((entry) => (
            <option key={entry.name} value={entry.name.toLowerCase()}>
              {entry.displayName}
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
