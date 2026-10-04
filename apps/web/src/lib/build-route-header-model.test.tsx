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
    isSearchMode: false,
    searchSubtitle: "Search results",
    dashboard: null,
    projectCount: 0,
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
      activeSessionId: "session-1",
    } as const,
    {
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
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
});
