import type { ReactNode } from "react";
import type { AgentInfo, DashboardData, ProjectGroup, SessionData } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { getProjectPath, type ProjectRouteIdentity } from "../lib/projects";
import { getSessionDisplayTitle } from "./session-title";
import type { ViewState } from "../lib/view-state";
import { SmartTagChips } from "../components/SmartTagChips";
import type { BrowseBy } from "../components/app/types";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface RouteHeaderInput {
  viewState: ViewState;
  browseBy: BrowseBy;
  isSearchMode: boolean;
  searchSubtitle: string;
  dashboard: DashboardData | null;
  projects: ProjectGroup[];
  sessionCount: number;
  activeProject: ProjectGroup | null;
  activeAgent: AgentInfo | null;
  sidebarSessionCount: number;
  session: SessionData | null;
  sessionError: string | null;
  selectedProjectIdentity: ProjectRouteIdentity | null;
  selectedProject: ProjectGroup | null;
}

export function buildRouteHeaderModel(input: RouteHeaderInput): {
  title: string;
  subtitle: ReactNode;
  breadcrumbs: BreadcrumbItem[];
} {
  const titleAndSubtitle = routeTitleAndSubtitle(input);
  return { ...titleAndSubtitle, breadcrumbs: routeBreadcrumbs(input) };
}

function routeTitleAndSubtitle(input: RouteHeaderInput): {
  title: string;
  subtitle: ReactNode;
} {
  const { viewState } = input;
  if (input.isSearchMode) return { title: "Search", subtitle: input.searchSubtitle };
  if (viewState.mode === "root") {
    return {
      title: "Dashboard",
      subtitle: input.dashboard
        ? `${input.dashboard.totals.sessions.toLocaleString("en-US")} total sessions across ${input.dashboard.perAgent.length} agents`
        : "Aggregated view across all agents",
    };
  }
  if (viewState.mode === "projects") {
    return {
      title: "Projects",
      subtitle: `${input.projects.length.toLocaleString("en-US")} projects across ${input.sessionCount.toLocaleString("en-US")} sessions`,
    };
  }
  if (viewState.mode === "project") {
    return {
      title: input.activeProject?.displayName ?? "Project",
      subtitle: input.activeProject
        ? `${input.activeProject.sessionCount.toLocaleString("en-US")} sessions · ${input.activeProject.agentStats.length} agents`
        : viewState.activeProjectKey,
    };
  }
  if (viewState.mode === "agent") {
    return {
      title: input.activeAgent?.displayName ?? viewState.activeAgentKey,
      subtitle: `${input.sidebarSessionCount} sessions`,
    };
  }
  if (viewState.mode === "session") {
    if (input.sessionError) {
      return {
        title: "Session Not Found",
        subtitle: `Requested /${viewState.activeAgentKey}/${viewState.activeSessionSlug}`,
      };
    }
    if (input.session) {
      const updated = input.session.time_updated ?? input.session.time_created;
      return {
        title: getSessionDisplayTitle(input.session) || "Conversation",
        subtitle: (
          <>
            <span>ID: #{input.session.id.slice(0, 8)}</span>
            <span>·</span>
            <span>Updated {formatRelativeTime(updated)}</span>
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
    to:
      (input.browseBy === "agents" && viewState.mode === "root") ||
      (input.browseBy === "projects" && viewState.mode === "projects")
        ? undefined
        : input.browseBy === "projects"
          ? "/projects"
          : "/",
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
  if (
    viewState.mode === "session" &&
    input.browseBy === "projects" &&
    input.selectedProjectIdentity
  ) {
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
          : viewState.activeSessionSlug || "Conversation",
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
    return [dashboard, agent, { label: viewState.attemptedSessionSlug }];
  }
  if (viewState.mode === "session") {
    return [
      dashboard,
      agent,
      {
        label: input.session
          ? getSessionDisplayTitle(input.session)
          : viewState.activeSessionSlug || "Conversation",
      },
    ];
  }
  return [dashboard, { label: "Invalid Route" }];
}
