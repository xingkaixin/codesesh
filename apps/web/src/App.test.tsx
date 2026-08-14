import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_SESSIONS_UPDATED_EVENT, SAMPLE_SESSION_HEAD } from "@codesesh/core/test-fixtures";
import type { ApiProjectGroup, DashboardData, SessionsUpdatedEvent } from "./lib/api";
import App from "./App";
import { appRouteChildren } from "./lib/app-routes";
import { createQueryClient } from "./lib/query-client";
import { ScanStatusProvider } from "./hooks/useScanStatus";

const liveSubscription = vi.hoisted(() => ({
  onUpdate: undefined as ((event: SessionsUpdatedEvent) => void) | undefined,
}));

vi.mock("./lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api")>()),
  subscribeSessionUpdates: (onUpdate: (event: SessionsUpdatedEvent) => void) => {
    liveSubscription.onUpdate = onUpdate;
    return () => undefined;
  },
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
  liveSubscription.onUpdate = undefined;
  responses["/api/agents"] = [];
  responses["/api/projects"] = { projects: [workspaceProject] };
  responses["/api/sessions"] = { sessions: [] };
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderAppAt(path: string) {
  const router = createMemoryRouter(
    [{ id: "app-shell", path: "/", Component: App, children: appRouteChildren }],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <ScanStatusProvider>
        <RouterProvider router={router} />
      </ScanStatusProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

function dashboardRequests(): URLSearchParams[] {
  return requestedUrls
    .filter((url) => url.startsWith("/api/dashboard"))
    .map((url) => new URLSearchParams(url.split("?")[1] ?? ""));
}

describe("App live updates", () => {
  it("preserves keyboard selection when a live update replaces the session list", async () => {
    const sidebarSession = {
      ...SAMPLE_SESSION_HEAD,
      id: "sidebar-session",
      slug: "claudecode/sidebar-session",
      project_identity: { kind: "path" as const, key: "/workspace", displayName: "workspace" },
    };
    responses["/api/agents"] = [{ name: "claudecode", displayName: "Claude Code", count: 1 }];
    responses["/api/sessions"] = { sessions: [sidebarSession] };
    const { router } = renderAppAt("/projects/path/%2Fworkspace");

    await waitFor(() => expect(document.querySelector("file-tree-container")).toBeTruthy());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", cancelable: true }));

    vi.useFakeTimers();
    await act(async () => {
      liveSubscription.onUpdate?.({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedAgents: ["claudecode"],
        newSessions: 0,
        newSessionRefs: [],
        totalSessions: 1,
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: sidebarSession.id },
            session: { ...sidebarSession, display_title: "Live title" },
          },
        ],
        projectionSessionOrder: [{ agentName: "claudecode", sessionId: sidebarSession.id }],
      });
      await vi.advanceTimersByTimeAsync(500);
    });
    vi.useRealTimers();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/claudecode/sidebar-session"));
  });
});

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
