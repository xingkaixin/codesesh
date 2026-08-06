import type { ReactNode } from "react";
import type { AgentInfo, DashboardData, ApiProjectGroup, SessionDetail } from "../lib/api";
import { formatInt, formatRelativeTime } from "../lib/format";
import { getProjectPath, type ProjectRouteIdentity } from "../lib/projects";
import { getSessionDisplayTitle } from "./session-title";
import type { ViewState } from "../lib/view-state";
import { SmartTagChips } from "../components/SmartTagChips";

function Count({ value }: { value: number }) {
  return <span className="console-mono">{formatInt(value)}</span>;
}

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface RouteHeaderInput {
  viewState: ViewState;
  isSearchMode: boolean;
  searchSubtitle: string;
  dashboard: DashboardData | null;
  projects: ApiProjectGroup[];
  sessionCount: number;
  activeProject: ApiProjectGroup | null;
  activeAgent: AgentInfo | null;
  sidebarSessionCount: number;
  session: SessionDetail | null;
  sessionError: string | null;
  selectedProjectIdentity: ProjectRouteIdentity | null;
  selectedProject: ApiProjectGroup | null;
}

export function buildRouteHeaderModel(input: RouteHeaderInput): {
  contextLabel: string;
  title: string;
  subtitle: ReactNode;
  breadcrumbs: BreadcrumbItem[];
} {
  const titleAndSubtitle = routeTitleAndSubtitle(input);
  return {
    contextLabel: routeContextLabel(input),
    ...titleAndSubtitle,
    breadcrumbs: routeBreadcrumbs(input),
  };
}

function routeContextLabel(input: RouteHeaderInput): string {
  if (input.isSearchMode) return "Search";

  switch (input.viewState.mode) {
    case "session":
      return "Session";
    case "root":
      return "Dashboard";
    case "projects":
      return "Projects";
    case "project":
      return "Project";
    default:
      return "Landing";
  }
}

function routeTitleAndSubtitle(input: RouteHeaderInput): {
  title: string;
  subtitle: ReactNode;
} {
  const { viewState } = input;
  if (input.isSearchMode) return { title: "Search", subtitle: input.searchSubtitle };
  if (viewState.mode === "root") {
    const dashboard = input.dashboard;
    return {
      title: "Dashboard",
      subtitle: dashboard ? (
        <span>
          <Count value={dashboard.totals.sessions} /> total sessions across{" "}
          <Count value={dashboard.perAgent.length} /> agents
        </span>
      ) : (
        "Aggregated view across all agents"
      ),
    };
  }
  if (viewState.mode === "projects") {
    return {
      title: "Projects",
      subtitle: (
        <span>
          <Count value={input.projects.length} /> projects across{" "}
          <Count value={input.sessionCount} /> sessions
        </span>
      ),
    };
  }
  if (viewState.mode === "project") {
    const activeProject = input.activeProject;
    return {
      title: activeProject?.displayName ?? "Project",
      subtitle: activeProject ? (
        <span>
          <Count value={activeProject.sessionCount} /> sessions ·{" "}
          <Count value={activeProject.agentStats.length} /> agents
        </span>
      ) : (
        viewState.activeProjectKey
      ),
    };
  }
  if (viewState.mode === "agent") {
    return {
      title: input.activeAgent?.displayName ?? viewState.activeAgentKey,
      subtitle: (
        <span>
          <Count value={input.sidebarSessionCount} /> sessions
        </span>
      ),
    };
  }
  if (viewState.mode === "session") {
    if (input.sessionError) {
      return {
        title: "Session Not Found",
        subtitle: `Requested /${viewState.activeAgentKey}/${viewState.activeSessionId}`,
      };
    }
    if (input.session) {
      const updated = input.session.time_updated ?? input.session.time_created;
      return {
        title: getSessionDisplayTitle(input.session) || "Session",
        subtitle: (
          <>
            <span className="console-mono">ID: #{input.session.id.slice(0, 8)}</span>
            <span>·</span>
            <span className="console-mono">Updated {formatRelativeTime(updated)}</span>
            <SmartTagChips tags={input.session.smart_tags} limit={9} className="inline-flex" />
          </>
        ),
      };
    }
  }
  if (viewState.mode === "missingAgent") {
    return { title: "Agent Not Found", subtitle: `Requested /${viewState.attemptedKey}` };
  }
  if (viewState.mode === "missingSession") {
    return {
      title: "Session Not Found",
      subtitle: `Session not found in /${viewState.activeAgentKey}`,
    };
  }
  return { title: "CodeSesh", subtitle: "Select an agent to browse sessions" };
}

function routeBreadcrumbs(input: RouteHeaderInput): BreadcrumbItem[] {
  const { viewState } = input;
  if (input.isSearchMode) return [{ label: "Search" }];

  const dashboard: BreadcrumbItem = {
    label: "Dashboard",
    to: viewState.mode === "root" ? undefined : "/",
  };
  if (viewState.mode === "root") return [{ label: "Dashboard" }];
  if (viewState.mode === "projects") return [dashboard, { label: "Projects" }];
  if (viewState.mode === "project") {
    return [
      dashboard,
      { label: "Projects", to: "/projects" },
      { label: input.activeProject?.displayName ?? viewState.activeProjectKey },
    ];
  }
  if (viewState.mode === "session" && input.selectedProjectIdentity) {
    return [
      dashboard,
      { label: "Projects", to: "/projects" },
      {
        label: input.selectedProject?.displayName ?? input.selectedProjectIdentity.key,
        to: getProjectPath(input.selectedProjectIdentity),
      },
      {
        label: input.session
          ? getSessionDisplayTitle(input.session)
          : viewState.activeSessionId || "Session",
      },
    ];
  }
  if (viewState.mode === "missingAgent") {
    return [dashboard, { label: viewState.attemptedKey }];
  }

  const agentLabel = input.activeAgent?.displayName ?? viewState.activeAgentKey ?? "Unknown Agent";
  const agent: BreadcrumbItem = {
    label: agentLabel,
    to: viewState.mode === "session" ? `/${viewState.activeAgentKey}` : undefined,
  };
  if (viewState.mode === "agent") return [dashboard, { label: agentLabel }];
  if (viewState.mode === "missingSession") {
    return [dashboard, agent, { label: viewState.attemptedSessionId }];
  }
  if (viewState.mode === "session") {
    return [
      dashboard,
      agent,
      {
        label: input.session
          ? getSessionDisplayTitle(input.session)
          : viewState.activeSessionId || "Session",
      },
    ];
  }
  return [dashboard, { label: "Invalid Route" }];
}
