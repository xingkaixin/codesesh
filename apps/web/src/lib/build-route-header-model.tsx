import { t } from "../i18n/translate";
import type { ReactNode } from "react";
import type { AgentInfo, ApiProjectGroup, SessionDetail } from "../lib/api";
import { formatInt, formatRelativeTime } from "../lib/format";
import { getProjectPath, type ProjectRouteIdentity } from "../lib/projects";
import { getSessionDisplayTitle } from "./session-title";
import type { ViewState } from "../lib/view-state";
import { SmartTagChips } from "../components/SmartTagChips";

export interface BreadcrumbItem {
  label: string;
  to?: string;
  mono?: boolean;
}

interface RouteHeaderInput {
  viewState: ViewState;
  isSearchMode: boolean;
  searchResultCount: number | null;
  projectCount: number;
  activeProject: ApiProjectGroup | null;
  activeAgent: AgentInfo | null;
  sidebarSessionCount: number;
  session: SessionDetail | null;
  sessionError: "missing" | "load-failed" | null;
  sessionSourceLabel: string | null;
  selectedProjectIdentity: ProjectRouteIdentity | null;
  selectedProject: ApiProjectGroup | null;
}

export interface RouteHero {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  tags?: ReactNode;
}

/**
 * The page bar shows either a breadcrumb trail (pages under a parent) or a plain
 * title with an optional count. The hero is the large title block at the top of
 * the scrolling body; pages that draw their own hero leave it null.
 */
export interface RouteHeaderModel {
  title: string;
  count: number | null;
  breadcrumbs: BreadcrumbItem[];
  hero: RouteHero | null;
}

export function buildRouteHeaderModel(input: RouteHeaderInput): RouteHeaderModel {
  const { viewState } = input;
  const dashboard: BreadcrumbItem = { label: t("Dashboard"), to: "/" };

  if (input.isSearchMode) {
    return { title: t("Search"), count: input.searchResultCount, breadcrumbs: [], hero: null };
  }

  switch (viewState.mode) {
    case "root":
      return { title: t("Dashboard"), count: null, breadcrumbs: [], hero: null };
    case "projects":
      return { title: t("All projects"), count: input.projectCount, breadcrumbs: [], hero: null };
    case "project": {
      const label = input.activeProject?.displayName ?? viewState.activeProjectKey;
      return {
        title: label,
        count: null,
        breadcrumbs: [
          dashboard,
          { label: t("All projects"), to: "/projects" },
          { label, mono: true },
        ],
        hero: null,
      };
    }
    case "agent": {
      const label = input.activeAgent?.displayName ?? viewState.activeAgentKey;
      return {
        title: label,
        count: null,
        breadcrumbs: [dashboard, { label }],
        hero: {
          eyebrow: t("Agent"),
          title: label,
          subtitle: t("{0} sessions", [formatInt(input.sidebarSessionCount)]),
        },
      };
    }
    case "session":
      return sessionHeader(input, dashboard);
    case "missingAgent":
      return {
        title: t("Agent Not Found"),
        count: null,
        breadcrumbs: [dashboard, { label: viewState.attemptedKey }],
        hero: {
          eyebrow: t("Agent"),
          title: t("Agent Not Found"),
          subtitle: t("Requested /{0}", [viewState.attemptedKey]),
        },
      };
    default:
      return {
        title: "CodeSesh",
        count: null,
        breadcrumbs: [dashboard, { label: t("Invalid Route") }],
        hero: {
          eyebrow: "CodeSesh",
          title: t("Invalid Route"),
          subtitle: t("Select an agent to browse sessions"),
        },
      };
  }
}

function sessionHeader(input: RouteHeaderInput, dashboard: BreadcrumbItem): RouteHeaderModel {
  const { viewState, session } = input;
  if (viewState.mode !== "session") throw new Error("sessionHeader needs a session route");

  const sessionLabel = session
    ? getSessionDisplayTitle(session)
    : viewState.activeSessionId || t("Session");
  const parent: BreadcrumbItem = input.selectedProjectIdentity
    ? {
        label: input.selectedProject?.displayName ?? input.selectedProjectIdentity.key,
        to: getProjectPath(input.selectedProjectIdentity),
        mono: true,
      }
    : {
        label: input.activeAgent?.displayName ?? viewState.activeAgentKey,
        to: `/${viewState.activeAgentKey}`,
      };
  const breadcrumbs = [dashboard, parent, { label: sessionLabel }];
  const eyebrow = [t("Session"), input.activeAgent?.displayName, input.sessionSourceLabel]
    .filter(Boolean)
    .join(" · ");

  if (input.sessionError) {
    const title =
      input.sessionError === "missing" ? t("Session Not Found") : t("Session Load Failed");
    return {
      title,
      count: null,
      breadcrumbs,
      hero: {
        eyebrow,
        title,
        subtitle: t("Requested /{0}/{1}", [viewState.activeAgentKey, viewState.activeSessionId]),
      },
    };
  }
  if (!session) return { title: sessionLabel, count: null, breadcrumbs, hero: null };

  const updated = session.time_updated ?? session.time_created;
  return {
    title: sessionLabel,
    count: null,
    breadcrumbs,
    hero: {
      eyebrow,
      title: getSessionDisplayTitle(session) || t("Session"),
      subtitle: (
        <>
          <span>#{session.reference.sessionId.slice(0, 8)}</span>
          <span>·</span>
          <span>
            {t("Updated")} {formatRelativeTime(updated)}
          </span>
          {session.directory ? (
            <>
              <span>·</span>
              <span className="min-w-0 break-all">{session.directory}</span>
            </>
          ) : null}
        </>
      ),
      tags: session.smart_tags?.length ? (
        <SmartTagChips tags={session.smart_tags} limit={9} />
      ) : undefined,
    },
  };
}
