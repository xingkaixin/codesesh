import { t } from "../i18n/translate";
import type { ReactNode } from "react";
import type { AgentInfo, DashboardData, ApiProjectGroup, SessionDetail } from "../lib/api";
import { formatInt, formatRelativeTime } from "../lib/format";
import { getProjectPath, type ProjectRouteIdentity } from "../lib/projects";
import { getSessionDisplayTitle } from "./session-title";
import type { ViewState } from "../lib/view-state";
import { SmartTagChips } from "../components/SmartTagChips";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface RouteHeaderInput {
  viewState: ViewState;
  isSearchMode: boolean;
  searchSubtitle: string;
  dashboard: DashboardData | null;
  projectCount: number;
  sessionCount: number;
  activeProject: ApiProjectGroup | null;
  activeAgent: AgentInfo | null;
  sidebarSessionCount: number;
  session: SessionDetail | null;
  sessionError: "missing" | "load-failed" | null;
  selectedProjectIdentity: ProjectRouteIdentity | null;
  selectedProject: ApiProjectGroup | null;
}

export interface RouteHeaderModel {
  contextLabel: string;
  title: string;
  subtitle: ReactNode;
  breadcrumbs: BreadcrumbItem[];
}

export function buildRouteHeaderModel(input: RouteHeaderInput): RouteHeaderModel {
  const titleAndSubtitle = routeTitleAndSubtitle(input);
  return {
    contextLabel: routeContextLabel(input),
    ...titleAndSubtitle,
    breadcrumbs: routeBreadcrumbs(input),
  };
}

function routeContextLabel(input: RouteHeaderInput): string {
  if (input.isSearchMode) return t("Search");

  switch (input.viewState.mode) {
    case "session":
      return t("Session");
    case "root":
      return t("Dashboard");
    case "projects":
      return t("Projects");
    case "project":
      return t("Project");
    default:
      return t("Landing");
  }
}

function routeTitleAndSubtitle(input: RouteHeaderInput): {
  title: string;
  subtitle: ReactNode;
} {
  const { viewState } = input;
  if (input.isSearchMode) return { title: t("Search"), subtitle: input.searchSubtitle };
  if (viewState.mode === "root") {
    const dashboard = input.dashboard;
    return {
      title: t("Dashboard"),
      subtitle: dashboard ? (
        <span>
          {t("{0} total sessions across {1} agents", [
            formatInt(dashboard.totals.sessions),
            formatInt(dashboard.perAgent.length),
          ])}
        </span>
      ) : (
        t("Aggregated view across all agents")
      ),
    };
  }
  if (viewState.mode === "projects") {
    return {
      title: t("Projects"),
      subtitle: (
        <span>
          {t("{0} projects across {1} sessions", [
            formatInt(input.projectCount),
            formatInt(input.sessionCount),
          ])}
        </span>
      ),
    };
  }
  if (viewState.mode === "project") {
    const activeProject = input.activeProject;
    return {
      title: activeProject?.displayName ?? t("Project"),
      subtitle: activeProject ? (
        <span>
          {t("{0} sessions · {1} agents", [
            formatInt(activeProject.sessionCount),
            formatInt(activeProject.agentStats.length),
          ])}
        </span>
      ) : (
        viewState.activeProjectKey
      ),
    };
  }
  if (viewState.mode === "agent") {
    return {
      title: input.activeAgent?.displayName ?? viewState.activeAgentKey,
      subtitle: <span>{t("{0} sessions", [formatInt(input.sidebarSessionCount)])}</span>,
    };
  }
  if (viewState.mode === "session") {
    if (input.sessionError) {
      return {
        title: input.sessionError === "missing" ? t("Session Not Found") : t("Session Load Failed"),
        subtitle: t("Requested /{0}/{1}", [viewState.activeAgentKey, viewState.activeSessionId]),
      };
    }
    if (input.session) {
      const updated = input.session.time_updated ?? input.session.time_created;
      return {
        title: getSessionDisplayTitle(input.session) || t("Session"),
        subtitle: (
          <>
            <span className="console-mono">
              ID: #{input.session.reference.sessionId.slice(0, 8)}
            </span>
            <span>·</span>
            <span className="console-mono">
              {t("Updated")} {formatRelativeTime(updated)}
            </span>
            <SmartTagChips tags={input.session.smart_tags} limit={9} className="inline-flex" />
          </>
        ),
      };
    }
  }
  if (viewState.mode === "missingAgent") {
    return { title: t("Agent Not Found"), subtitle: t("Requested /{0}", [viewState.attemptedKey]) };
  }
  return { title: "CodeSesh", subtitle: t("Select an agent to browse sessions") };
}

function routeBreadcrumbs(input: RouteHeaderInput): BreadcrumbItem[] {
  const { viewState } = input;
  if (input.isSearchMode) return [{ label: t("Search") }];

  const dashboard: BreadcrumbItem = {
    label: t("Dashboard"),
    to: viewState.mode === "root" ? undefined : "/",
  };
  if (viewState.mode === "root") return [{ label: t("Dashboard") }];
  if (viewState.mode === "projects") return [dashboard, { label: t("Projects") }];
  if (viewState.mode === "project") {
    return [
      dashboard,
      { label: t("Projects"), to: "/projects" },
      { label: input.activeProject?.displayName ?? viewState.activeProjectKey },
    ];
  }
  if (viewState.mode === "session" && input.selectedProjectIdentity) {
    return [
      dashboard,
      { label: t("Projects"), to: "/projects" },
      {
        label: input.selectedProject?.displayName ?? input.selectedProjectIdentity.key,
        to: getProjectPath(input.selectedProjectIdentity),
      },
      {
        label: input.session
          ? getSessionDisplayTitle(input.session)
          : viewState.activeSessionId || t("Session"),
      },
    ];
  }
  if (viewState.mode === "missingAgent") {
    return [dashboard, { label: viewState.attemptedKey }];
  }

  const agentLabel =
    input.activeAgent?.displayName ?? viewState.activeAgentKey ?? t("Unknown Agent");
  const agent: BreadcrumbItem = {
    label: agentLabel,
    to: viewState.mode === "session" ? `/${viewState.activeAgentKey}` : undefined,
  };
  if (viewState.mode === "agent") return [dashboard, { label: agentLabel }];
  if (viewState.mode === "session") {
    return [
      dashboard,
      agent,
      {
        label: input.session
          ? getSessionDisplayTitle(input.session)
          : viewState.activeSessionId || t("Session"),
      },
    ];
  }
  return [dashboard, { label: t("Invalid Route") }];
}
