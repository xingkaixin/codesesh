import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiProjectGroup, DashboardData } from "./lib/api";
import App from "./App";
import { appRouteChildren } from "./lib/app-routes";
import { createQueryClient } from "./lib/query-client";

vi.mock("./lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api")>()),
  subscribeSessionUpdates: () => () => undefined,
  logClientEvent: () => undefined,
}));

const emptyDashboard: DashboardData = {
  totals: {
    sessions: 0,
    messages: 0,
    tokens: 0,
    cost: 0,
    costRecorded: 0,
    costEstimated: 0,
    cacheReadTokens: 0,
  },
  scopeCounts: { projects: 0, agents: 0 },
  perAgent: [],
  dailyActivity: [],
  dailyTokenActivity: [],
  modelDistribution: [],
  modelCost: null,
  perProject: [],
  projectRollup: { projects: 0, sessions: 0, tokens: 0, cost: 0 },
  recentSessions: [],
  recentFileActivities: [],
  window: { to: 1_700_000_000_000 },
};

const workspaceProject: ApiProjectGroup = {
  identityKind: "path",
  identityKey: "/workspace",
  displayName: "workspace",
  sources: ["/workspace"],
  sessionCount: 0,
  lastActivity: null,
  messages: 0,
  tokens: 0,
  cost: 0,
  agentStats: [],
};

const responses: Record<string, unknown> = {
  "/api/config": { window: { days: 30 } },
  "/api/agents": [],
  "/api/projects": { projects: [workspaceProject] },
  "/api/sessions": { sessions: [] },
  "/api/dashboard": emptyDashboard,
  "/api/bookmarks": { bookmarks: [] },
  "/api/status": {
    type: "scan-status",
    active: false,
    phase: "idle",
    pendingAgents: [],
    scanningAgents: [],
    completedAgents: [],
    agentStatuses: {},
    totalAgents: 0,
    updatedAt: 0,
    backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
  },
};

let requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls = [];
  vi.stubGlobal("__APP_VERSION__", "0.0.0-test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    const body = responses[url.split("?")[0] ?? ""] ?? {};
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAppAt(path: string) {
  const router = createMemoryRouter(
    [{ id: "app-shell", path: "/", Component: App, children: appRouteChildren }],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function dashboardRequests(): URLSearchParams[] {
  return requestedUrls
    .filter((url) => url.startsWith("/api/dashboard"))
    .map((url) => new URLSearchParams(url.split("?")[1] ?? ""));
}

describe("App dashboard scope wiring", () => {
  it("requests the project scope on a project route", async () => {
    renderAppAt("/projects/path/%2Fworkspace");

    await waitFor(() =>
      expect(
        dashboardRequests().some(
          (params) =>
            params.get("projectKind") === "path" && params.get("projectKey") === "/workspace",
        ),
      ).toBe(true),
    );
  });

  it("never scopes the dashboard to a project outside a project route", async () => {
    renderAppAt("/");

    await waitFor(() => expect(dashboardRequests().length).toBeGreaterThan(0));
    expect(dashboardRequests().every((params) => params.get("projectKey") === null)).toBe(true);
  });
});
