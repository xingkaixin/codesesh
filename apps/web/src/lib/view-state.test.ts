import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { appRouteChildren } from "./app-routes";
import { getProjectPath } from "./projects";
import { sessionRoutePath } from "./session-indexes";
import { viewStateFromRouteMatches } from "./view-state";

const agents = new Set(["claudecode", "codex"]);
const routes: RouteObject[] = [{ path: "/", children: appRouteChildren }];

it("keeps the source node when opening a remote session", () => {
  const reference = { sourceNodeId: "worker-a", agentName: "codex", sessionId: "same/id" };
  expect(viewState(sessionRoutePath(reference))).toEqual({
    mode: "session",
    sourceNodeId: "worker-a",
    activeAgentKey: "codex",
    activeSessionId: "same/id",
  });
});

function viewState(path: string) {
  const matches = (matchRoutes(routes, path) ?? []).map(({ params, route }) => ({
    id: route.id ?? "",
    params,
  }));
  return viewStateFromRouteMatches(matches, agents);
}

describe("viewStateFromRouteMatches", () => {
  it("maps the route graph to app view states", () => {
    expect(viewState("/")).toEqual({
      mode: "root",
      activeAgentKey: null,
      activeSessionId: null,
    });
    expect(viewState("/projects").mode).toBe("projects");
    expect(viewState("/claudecode")).toEqual({
      mode: "agent",
      activeAgentKey: "claudecode",
      activeSessionId: null,
    });
    expect(viewState("/codex/abc-123")).toEqual({
      mode: "session",
      activeAgentKey: "codex",
      activeSessionId: "abc-123",
    });
  });

  it.each(["nested/session", "query?part", "fragment#part", "percent%part", "unicode ✓"])(
    "CS-132: opens opaque session id %j from a canonical path",
    (sessionId) => {
      const path = sessionRoutePath({ agentName: "codex", sessionId });

      expect(viewState(path)).toEqual({
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: sessionId,
      });
    },
  );

  it("uses decoded router params for project identities", () => {
    const path = getProjectPath({ kind: "git_remote", key: "github.com/acme/app" });
    expect(viewState(path)).toEqual({
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
      activeProjectKind: "git_remote",
      activeProjectKey: "github.com/acme/app",
    });
  });
});
