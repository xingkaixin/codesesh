/**
 * Agent filter + range pills for 统计总览.
 *
 * Which project the dashboard covers is decided by navigation (the sidebar),
 * not by a control inside the page — so there is no scope switcher here. The
 * project dashboard mounts this bar without the agent picker, because the
 * project page already owns one that also filters its timeline.
 */
import { useState } from "react";
import type { AgentCatalog } from "../../lib/agents";
import type { TimeWindow, TimeWindowPreset } from "../../lib/time-window";
import { cn } from "../../lib/utils";
import { CustomTimeWindowDialog } from "../CustomTimeWindowDialog";
import { OVERVIEW_RANGE_PRESETS } from "./types";

const ALL_AGENTS = "__all__";

export function OverviewFilterBar({
  agent,
  onAgentChange,
  agentCatalog,
  scopeCounts,
  window,
  rangePreset,
  onRangeChange,
  onSelectCustom,
}: {
  agent?: string;
  onAgentChange?: (agent?: string) => void;
  agentCatalog: AgentCatalog;
  scopeCounts?: { projects: number; agents: number };
  window: TimeWindow | null;
  rangePreset: TimeWindowPreset | null;
  onRangeChange: (preset: TimeWindowPreset) => void;
  onSelectCustom: (from: string, to: string) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {onAgentChange ? (
          <select
            aria-label="Filter by agent"
            value={agent ?? ALL_AGENTS}
            onChange={(event) =>
              onAgentChange(event.target.value === ALL_AGENTS ? undefined : event.target.value)
            }
            className="console-mono max-w-[220px] rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1.5 text-xs text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            <option value={ALL_AGENTS}>All agents</option>
            {agentCatalog.active.map((entry) => (
              <option key={entry.name} value={entry.name.toLowerCase()}>
                {entry.displayName}
              </option>
            ))}
          </select>
        ) : null}

        {scopeCounts ? (
          <span className="console-mono text-[11px] text-[var(--console-muted)]">
            {scopeCounts.projects} projects · {scopeCounts.agents} agents in scope
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {OVERVIEW_RANGE_PRESETS.map((preset) => {
            const selected = preset.value === rangePreset;
            return (
              <button
                key={preset.value}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  if (preset.value === "custom") setCustomOpen(true);
                  else onRangeChange(preset.value);
                }}
                className={cn(
                  "console-mono motion-hover rounded-full border px-[13px] py-[5px] text-[11px] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
                  selected
                    ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
                    : "border-[var(--console-border)] bg-[var(--console-surface)] text-[var(--console-muted)]",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <CustomTimeWindowDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        window={window}
        onSelectCustom={onSelectCustom}
      />
    </>
  );
}
