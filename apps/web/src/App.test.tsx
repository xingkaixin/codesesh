import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_SESSIONS_UPDATED_EVENT, SAMPLE_SESSION_HEAD } from "@codesesh/core/test-fixtures";
import { createSessionIdentity } from "@codesesh/core/contract";
import type { ApiProjectGroup, DashboardData, SessionsUpdatedEvent } from "./lib/api";
import App from "./App";
import { appRouteChildren } from "./lib/app-routes";
import { createQueryClient } from "./lib/query-client";
import { ScanStatusProvider } from "./hooks/useScanStatus";

const LAZY_SURFACE_TIMEOUT_MS = 5_000;

const liveSubscription = vi.hoisted(() => ({
  onUpdate: undefined as ((event: SessionsUpdatedEvent) => void) | undefined,
}));
const clientTelemetry = vi.hoisted(() => ({
  logClientEvent: vi.fn<(event: string, data?: Record<string, unknown>) => void>(),
}));

vi.mock("./lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api")>()),
  subscribeSessionUpdates: (onUpdate: (event: SessionsUpdatedEvent) => void) => {
    liveSubscription.onUpdate = onUpdate;
    return () => undefined;
  },
  logClientEvent: clientTelemetry.logClientEvent,
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

const workspaceProjectPage = {
  projects: [workspaceProject],
  summary: {
    projects: 1,
    sessions: 0,
    tokens: 0,
    cost: 0,
    latestActivity: null,
  },
};

const responses: Record<string, unknown> = {
  "/api/config": { window: { days: 30 } },
  "/api/agents": [],
  "/api/projects": workspaceProjectPage,
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
let projectDetailResponse: unknown = null;

beforeEach(() => {
  requestedUrls = [];
  projectDetailResponse = null;
  liveSubscription.onUpdate = undefined;
  clientTelemetry.logClientEvent.mockClear();
  responses["/api/agents"] = [];
  responses["/api/projects"] = workspaceProjectPage;
  responses["/api/sessions"] = { sessions: [] };
  responses["/api/bookmarks"] = { bookmarks: [] };
  delete responses["/api/sessions/claudecode/session-1"];
  vi.stubGlobal("__APP_VERSION__", "0.0.0-test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url, "http://localhost");
    const body =
      parsed.pathname === "/api/projects" && parsed.searchParams.has("projectKey")
        ? (projectDetailResponse ?? responses[parsed.pathname] ?? {})
        : (responses[parsed.pathname] ?? {});
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

function routeChangeCalls() {
  return clientTelemetry.logClientEvent.mock.calls.filter(([event]) => event === "route.change");
}

describe("App session loading", () => {
  it("loads and copies an available bookmarked session as Markdown", async () => {
    const sessionDetail = {
      ...SAMPLE_SESSION_HEAD,
      messages: [
        {
          id: "message-1",
          role: "user",
          time_created: 1,
          parts: [{ type: "text", text: "Copy this conversation" }],
        },
      ],
    };
    responses["/api/agents"] = [{ name: "claudecode", displayName: "Claude Code", count: 1 }];
    responses["/api/bookmarks"] = {
      bookmarks: [
        {
          reference: SAMPLE_SESSION_HEAD.reference,
          bookmarkedAt: 1,
          availability: "available",
          session: SAMPLE_SESSION_HEAD,
        },
      ],
    };
    responses["/api/sessions/claudecode/session-1"] = sessionDetail;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderAppAt("/");

    fireEvent.click(await screen.findByRole("button", { name: "Session options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy as Markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain("## User\n\nCopy this conversation");
    expect(await screen.findByText("Session copied as Markdown.")).toBeTruthy();
  });

  it("opens session details when dashboard loading fails and retries statistics independently", async () => {
    responses["/api/agents"] = [{ name: "claudecode", displayName: "Claude Code", count: 1 }];
    responses["/api/sessions"] = { sessions: [SAMPLE_SESSION_HEAD] };
    let dashboardAvailable = false;
    const defaultFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/dashboard" && !dashboardAvailable) {
        return new Response("statistics unavailable", { status: 503 });
      }
      if (url.pathname === "/api/sessions/claudecode/session-1") {
        return Response.json({ ...SAMPLE_SESSION_HEAD, messages: [] });
      }
      return defaultFetch(input);
    });
    const { router } = renderAppAt("/claudecode/session-1");

    await screen.findByTestId("session-detail", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS });
    expect(
      screen.queryByText("Failed to load session data for the selected time window."),
    ).toBeNull();

    await act(() => router.navigate("/"));
    await screen.findByText(
      "Couldn't load the dashboard.",
      {},
      { timeout: LAZY_SURFACE_TIMEOUT_MS },
    );
    dashboardAvailable = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByText("Couldn't load the dashboard.")).toBeNull());
    expect(screen.getByTestId("dashboard")).toBeTruthy();
  });

  it("shows pagination progress and lets the user retry a failed later page", async () => {
    responses["/api/agents"] = [{ name: "claudecode", displayName: "Claude Code", count: 2 }];
    const finalSession = {
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({ agentName: "claudecode", sessionId: "last-page-session" }),
      title: "Session from the last page",
    };
    let failPage!: (response: Response) => void;
    const secondPage = new Promise<Response>((resolve) => {
      failPage = resolve;
    });
    let retry = false;
    const defaultFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/sessions") return defaultFetch(input);
      if (url.searchParams.has("cursor")) return secondPage;
      return Response.json({
        sessions: retry ? [SAMPLE_SESSION_HEAD, finalSession] : [SAMPLE_SESSION_HEAD],
        nextCursor: retry ? undefined : "second-page",
      });
    });
    renderAppAt("/claudecode");

    await screen.findByText("Loading sessions… Results are not yet complete.");
    await act(async () => {
      failPage(new Response("second page unavailable", { status: 503 }));
    });
    await screen.findByText(/Displayed sessions may be incomplete/);
    expect(screen.getAllByText(SAMPLE_SESSION_HEAD.title).length).toBeGreaterThan(0);

    retry = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry session load" }));

    await screen.findByText(finalSession.title);
    expect(screen.queryByText(/Displayed sessions may be incomplete/)).toBeNull();
    expect(screen.queryByText("Loading sessions… Results are not yet complete.")).toBeNull();
  });
});

describe("App live updates", () => {
  it("preserves keyboard selection when a live update replaces the session list", async () => {
    const sidebarSession = {
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({ agentName: "claudecode", sessionId: "sidebar-session" }),
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
        newSessionRefs: [],
        totalSessions: 1,
        changedSessionHeads: [
          {
            reference: sidebarSession.reference,
            session: { ...sidebarSession, display_title: "Live title" },
          },
        ],
        projectionSessionOrder: [sidebarSession.reference],
      });
      await vi.advanceTimersByTimeAsync(500);
    });
    vi.useRealTimers();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/claudecode/sidebar-session"));
  });
});

describe("App dashboard scope wiring", () => {
  it("resolves a project outside the bounded catalog page", async () => {
    const selectedProject = {
      ...workspaceProject,
      identityKey: "/outside-first-page",
      displayName: "outside-first-page",
    };
    projectDetailResponse = {
      projects: [selectedProject],
      summary: {
        projects: 1,
        sessions: 0,
        tokens: 0,
        cost: 0,
        latestActivity: null,
      },
    };

    renderAppAt("/projects/path/%2Foutside-first-page");

    expect(
      await screen.findByRole("heading", { level: 1, name: "outside-first-page" }),
    ).toBeTruthy();
    expect(requestedUrls.some((url) => url.includes("projectKey=%2Foutside-first-page"))).toBe(
      true,
    );
  });

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

describe("App route telemetry", () => {
  it("records concrete route changes within the same view without exposing route identity", async () => {
    const { router } = renderAppAt("/projects/path/%2Fworkspace");

    await waitFor(() => expect(routeChangeCalls()).toHaveLength(1));
    await act(async () => {
      await router.navigate("/projects/path/%2Fanother-workspace");
    });
    await waitFor(() => expect(routeChangeCalls()).toHaveLength(2));

    const [event, payload] = routeChangeCalls()[1] ?? [];
    expect(event).toBe("route.change");
    expect(payload).toMatchObject({ mode: "project" });
    expect(payload).not.toHaveProperty("path");
    expect(payload).not.toHaveProperty("project");
    expect(payload).not.toHaveProperty("projectKey");
  });
});
