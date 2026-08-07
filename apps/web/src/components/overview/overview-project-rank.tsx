/**
 * The ranking card. Ranking projects inside a single project is meaningless, so
 * under a project scope the very same card ranks agents instead — one component,
 * two row sources.
 */
import type { DashboardProjectRollup } from "@codesesh/core/contract";
import { Link } from "react-router-dom";

import { findAgent, type AgentCatalog } from "../../lib/agents";
import { AgentIcon } from "../AgentIcon";
import type { DashboardAgentStat, DashboardFilters, DashboardProjectStat } from "../../lib/api";
import { formatCompact, formatInt, formatUsd } from "../../lib/format";
import { Panel, PanelHeader } from "../ui/panel";
import { ShareBar } from "../ui/share-bar";
import { Sparkline } from "../ui/sparkline";

const RANK_LIMIT = 6;

interface RankRow {
  key: string;
  name: string;
  agentKeys?: string[];
  sessions: number;
  tokens: number;
  cost: number;
  sparkline?: number[];
  icon?: string;
  iconColored?: boolean;
}

function toProjectRow(project: DashboardProjectStat): RankRow {
  return {
    key: `${project.identityKind}:${project.identityKey}`,
    name: project.displayName,
    agentKeys: project.agents,
    sessions: project.sessions,
    tokens: project.tokens,
    cost: project.cost,
    sparkline: project.sparkline,
  };
}

function toAgentRow(agent: DashboardAgentStat): RankRow {
  return {
    key: agent.name,
    name: agent.displayName,
    sessions: agent.sessions,
    tokens: agent.tokens,
    cost: agent.cost,
    icon: agent.icon,
    iconColored: agent.iconColored,
  };
}

function ProjectAgentLogos({
  agentKeys,
  agentCatalog,
}: {
  agentKeys: string[];
  agentCatalog: AgentCatalog;
}) {
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1">
      {agentKeys.map((agentKey) => {
        const agent = findAgent(agentCatalog, agentKey);
        if (!agent?.icon) return null;

        return (
          <AgentIcon
            key={agentKey}
            icon={agent.icon}
            iconColored={agent.iconColored}
            alt={agent.displayName}
            className="size-3 shrink-0 object-contain text-[var(--console-text)]"
          />
        );
      })}
    </span>
  );
}

export function OverviewProjectRank({
  filters,
  projects,
  perAgent,
  rollup,
  scopeCounts,
  agentCatalog,
}: {
  filters: DashboardFilters;
  projects: DashboardProjectStat[];
  perAgent: DashboardAgentStat[];
  rollup: DashboardProjectRollup;
  scopeCounts: { projects: number; agents: number };
  agentCatalog: AgentCatalog;
}) {
  const rankAgents = filters.project !== undefined;
  const rows = rankAgents ? perAgent.map(toAgentRow) : projects.map(toProjectRow);
  const visible = rows.slice(0, RANK_LIMIT);
  const topCost = visible.reduce((peak, row) => Math.max(peak, row.cost), 0);
  const showFooter = !rankAgents && rollup.projects > 0;

  return (
    <Panel className="p-4">
      <PanelHeader
        title={rankAgents ? "Agents" : "Projects"}
        meta={`by cost · ${rankAgents ? scopeCounts.agents : scopeCounts.projects} total`}
      />

      <div className="console-eyebrow mt-3 flex items-center gap-3 border-b border-[var(--console-border)] pb-2">
        <span className="min-w-0 flex-1">{rankAgents ? "Agent" : "Project"}</span>
        <span className="w-[52px] text-right">Sessions</span>
        <span className="w-[60px] text-right">Tokens</span>
        <span className="w-[66px] text-right">Cost</span>
        {rankAgents ? null : <span className="w-[74px]">14d</span>}
      </div>

      {visible.length === 0 ? (
        <p className="console-mono mt-3 text-[11px] text-[var(--console-muted)]">No data</p>
      ) : (
        <ul>
          {visible.map((row) => (
            <li
              key={row.key}
              data-testid="overview-project-row"
              className="flex items-center gap-3 border-b border-[var(--console-border)] py-[10px] last:border-b-0"
            >
              {row.icon ? (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                  <AgentIcon
                    icon={row.icon}
                    iconColored={row.iconColored}
                    alt={row.name}
                    className="size-3"
                  />
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--console-text)]">
                  {row.name}
                </p>
                <div className="mt-[5px] flex items-center gap-[6px]">
                  <ShareBar ratio={row.cost / topCost} className="h-1 max-w-[180px]" />
                  {row.agentKeys?.length ? (
                    <ProjectAgentLogos agentKeys={row.agentKeys} agentCatalog={agentCatalog} />
                  ) : null}
                </div>
              </div>
              <span className="console-mono w-[52px] shrink-0 text-right text-xs text-[var(--console-text)]">
                {formatInt(row.sessions)}
              </span>
              <span className="console-mono w-[60px] shrink-0 text-right text-xs text-[var(--console-muted)]">
                {formatCompact(row.tokens)}
              </span>
              <span className="console-mono w-[66px] shrink-0 text-right text-xs text-[var(--brand)]">
                {formatUsd(row.cost)}
              </span>
              {row.sparkline ? (
                <span className="w-[74px] shrink-0">
                  <Sparkline values={row.sparkline} label={`${row.name} 14-day cost`} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {showFooter ? (
        <div className="console-mono mt-3 flex items-center gap-3 border-t border-[var(--console-border)] pt-3 text-[10.5px] text-[var(--console-muted)]">
          <span className="min-w-0 truncate">
            {rollup.projects} more projects · {formatInt(rollup.sessions)} sessions ·{" "}
            {formatUsd(rollup.cost)}
          </span>
          <Link
            to="/projects"
            className="ml-auto shrink-0 text-[var(--brand)] hover:text-[var(--brand-hover)]"
          >
            View all {scopeCounts.projects} →
          </Link>
        </div>
      ) : null}
    </Panel>
  );
}
