/**
 * Agent share of the current scope. Cost is the ranking metric only when some
 * agent actually has one — printing $0.00 five times says nothing, so a
 * cost-free scope ranks and reads by session count instead.
 */
import type { DashboardAgentStat } from "../../lib/api";
import { formatInt, formatUsd } from "../../lib/format";
import { AgentIcon } from "../AgentIcon";
import { Panel, PanelHeader } from "../ui/panel";
import { ShareBar } from "../ui/share-bar";

const AGENT_LIMIT = 5;

export function OverviewAgentDistribution({ perAgent }: { perAgent: DashboardAgentStat[] }) {
  const byCost = perAgent.some((agent) => agent.cost > 0);
  const weightOf = (agent: DashboardAgentStat) => (byCost ? agent.cost : agent.sessions);
  const ranked = [...perAgent].sort((a, b) => weightOf(b) - weightOf(a));
  const visible = ranked.slice(0, AGENT_LIMIT);
  const peak = visible.reduce((max, agent) => Math.max(max, weightOf(agent)), 0);

  return (
    <Panel className="p-4">
      <PanelHeader title="Agents" meta={`${perAgent.length} total`} />

      {visible.length === 0 ? (
        <p className="console-mono mt-3 text-[11px] text-[var(--console-muted)]">No data</p>
      ) : (
        <ul className="mt-3 space-y-[10px]">
          {visible.map((agent, index) => (
            <li key={agent.name} data-testid="overview-agent-row">
              <div className="flex items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-text)]">
                  <AgentIcon
                    icon={agent.icon}
                    iconColored={agent.iconColored}
                    alt={agent.displayName}
                    className="size-3"
                  />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--console-text)]">
                  {agent.displayName}
                </span>
                <span className="console-mono shrink-0 text-[10.5px] text-[var(--console-muted)]">
                  {byCost
                    ? `${formatInt(agent.sessions)} · ${formatUsd(agent.cost)}`
                    : `${formatInt(agent.sessions)} sessions`}
                </span>
              </div>
              <div className="mt-[6px] flex" style={{ opacity: Math.max(0.4, 1 - index * 0.15) }}>
                <ShareBar ratio={weightOf(agent) / peak} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {perAgent.length > AGENT_LIMIT ? (
        <p className="console-mono mt-3 text-[10.5px] text-[var(--console-muted)]">
          + {perAgent.length - AGENT_LIMIT} more
        </p>
      ) : null}
    </Panel>
  );
}
