import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { APP_ROUTE_IDS, appRouteChildren, assertValidRouteEncoding } from "./app-routes";
import { getProjectPath } from "./projects";
import { viewStateFromRouteMatches } from "./view-state";

const agents = new Set(["claudecode", "codex"]);
const routes: RouteObject[] = [{ path: "/", children: appRouteChildren }];

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
      activeSessionSlug: null,
    });
    expect(viewState("/projects").mode).toBe("projects");
    expect(viewState("/claudecode")).toEqual({
      mode: "agent",
      activeAgentKey: "claudecode",
      activeSessionSlug: null,
    });
    expect(viewState("/codex/abc-123")).toEqual({
      mode: "session",
      activeAgentKey: "codex",
      activeSessionSlug: "abc-123",
    });
  });

  it("keeps the static projects route ahead of the agent parameter", () => {
    const matches = matchRoutes(routes, "/projects");
    expect(matches?.at(-1)?.route.id).toBe(APP_ROUTE_IDS.projects);
  });

  it("uses decoded router params for project identities", () => {
    const path = getProjectPath({ kind: "git_remote", key: "github.com/acme/app" });
    expect(viewState(path)).toEqual({
      mode: "project",
      activeAgentKey: null,
      activeSessionSlug: null,
      activeProjectKind: "git_remote",
      activeProjectKey: "github.com/acme/app",
    });
  });

  it("returns missingAgent for an unknown dynamic agent", () => {
    expect(viewState("/unknown")).toEqual({
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionSlug: null,
      attemptedKey: "unknown",
    });
  });

  it("maps invalid project kinds and wildcard paths to invalidRoute", () => {
    expect(viewState("/projects/invalid/key").mode).toBe("invalidRoute");
    expect(viewState("/a/b/c/d").mode).toBe("invalidRoute");
  });

  it("keeps query strings outside route identity", () => {
    expect(viewState("/codex/abc-123?window=7d").mode).toBe("session");
  });

  it("rejects malformed URL encoding at the route boundary", () => {
    expect(() =>
      assertValidRouteEncoding(new Request("http://localhost/projects/git_remote/%ZZ")),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
});
