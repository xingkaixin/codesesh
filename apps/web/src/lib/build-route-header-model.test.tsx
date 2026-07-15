import { describe, expect, it } from "vitest";
import type { ViewState } from "./view-state";
import { buildRouteHeaderModel } from "./build-route-header-model";

type RouteHeaderInput = Parameters<typeof buildRouteHeaderModel>[0];

function createInput(
  viewState: ViewState,
  overrides: Partial<RouteHeaderInput> = {},
): RouteHeaderInput {
  return {
    viewState,
    browseBy: "agents",
    isSearchMode: false,
    searchSubtitle: "Search results",
    dashboard: null,
    projects: [],
    sessionCount: 0,
    activeProject: null,
    activeAgent: null,
    sidebarSessionCount: 0,
    session: null,
    sessionError: null,
    selectedProjectIdentity: null,
    selectedProject: null,
    ...overrides,
  };
}

describe("buildRouteHeaderModel", () => {
  it.each([
    {
      mode: "session",
      activeAgentKey: "claudecode",
      activeSessionSlug: "session-1",
    } as const,
    {
      mode: "project",
      activeAgentKey: null,
      activeSessionSlug: null,
      activeProjectKind: "path",
      activeProjectKey: "/tmp/codesesh",
    } as const,
  ])("gives search precedence over a $mode route", (viewState) => {
    const model = buildRouteHeaderModel(
      createInput(viewState, {
        isSearchMode: true,
      }),
    );

    expect(model).toMatchObject({
      contextLabel: "Search",
      title: "Search",
      breadcrumbs: [{ label: "Search" }],
    });
  });

  it.each([
    [{ mode: "root", activeAgentKey: null, activeSessionSlug: null } as const, "Dashboard"],
    [{ mode: "projects", activeAgentKey: null, activeSessionSlug: null } as const, "Projects"],
    [
      {
        mode: "project",
        activeAgentKey: null,
        activeSessionSlug: null,
        activeProjectKind: "path",
        activeProjectKey: "/tmp/codesesh",
      } as const,
      "Project",
    ],
    [
      {
        mode: "session",
        activeAgentKey: "claudecode",
        activeSessionSlug: "session-1",
      } as const,
      "Session",
    ],
    [{ mode: "agent", activeAgentKey: "claudecode", activeSessionSlug: null } as const, "Landing"],
  ])("keeps the existing $1 context for non-search routes", (viewState, expected) => {
    expect(buildRouteHeaderModel(createInput(viewState)).contextLabel).toBe(expected);
  });
});
