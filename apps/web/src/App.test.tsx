import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import {
  createSessionIdentity,
  type ApiProjectGroup,
  type DashboardData,
} from "@codesesh/contract";
import App from "./App";
import { appRouteChildren } from "./lib/app-routes";
import { createQueryClient } from "./lib/query-client";
import { ScanStatusProvider } from "./hooks/useScanStatus";

const LAZY_SURFACE_TIMEOUT_MS = 5_000;

// oxlint-disable-next-line anti-slop/no-module-mocking -- Render the app without a live SSE server or telemetry side effects.
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
  modelDistribution: [],
  modelCost: null,
  perProject: [],
  projectRollup: { projects: 0, sessions: 0, tokens: 0, cost: 0 },
  recentSessions: [],
  recentFileActivities: [],
  activeHours: null,
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

// oxlint-disable-next-line anti-slop/no-known-value-widening -- This fetch fixture routes heterogeneous JSON response schemas by endpoint path.
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
let projectDetailResponse: typeof workspaceProjectPage | null = null;

beforeEach(() => {
  requestedUrls = [];
  projectDetailResponse = null;
  responses["/api/config"] = { window: { days: 30 } };
  responses["/api/agents"] = [];
  responses["/api/projects"] = workspaceProjectPage;
  responses["/api/sessions"] = { sessions: [] };
  responses["/api/dashboard"] = emptyDashboard;
  responses["/api/bookmarks"] = { bookmarks: [] };
  responses["/api/pricing/overview"] = { unmatchedModels: [], overrides: [], attentionCount: 0 };
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

describe("App session loading", () => {
  it("opens session details when dashboard loading fails and retries statistics independently", async () => {
    responses["/api/agents"] = [{ name: "claudecode", displayName: "Claude Code", count: 1 }];
    responses["/api/sessions"] = { sessions: [SAMPLE_SESSION_HEAD] };
    let dashboardAvailable = false;
    let dashboardAttempts = 0;
    const defaultFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/dashboard") dashboardAttempts += 1;
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
    expect(dashboardAttempts).toBe(0);
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
    expect(
      (
        await screen.findAllByText(
          SAMPLE_SESSION_HEAD.title,
          {},
          { timeout: LAZY_SURFACE_TIMEOUT_MS },
        )
      ).length,
    ).toBeGreaterThan(0);

    retry = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry session load" }));

    await screen.findByText(finalSession.title);
    expect(screen.queryByText(/Displayed sessions may be incomplete/)).toBeNull();
    expect(screen.queryByText("Loading sessions… Results are not yet complete.")).toBeNull();
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
});

it("offers a remote resume command with its source machine clearly identified", async () => {
  responses["/api/agents"] = [
    {
      name: "claudecode",
      displayName: "Claude Code",
      count: 1,
      resumeCommandPrefix: "claude --resume",
    },
  ];
  const defaultFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    if (
      new URL(String(input), "http://localhost").pathname ===
      "/api/sessions/nodes/office/claudecode/session-1"
    ) {
      return Promise.resolve(
        Response.json({
          ...SAMPLE_SESSION_HEAD,
          reference: { ...SAMPLE_SESSION_HEAD.reference, sourceNodeId: "office" },
          directory: "/office/worktree",
          messages: [],
        }),
      );
    }
    return defaultFetch(input);
  });
  renderAppAt("/nodes/office/claudecode/session-1");
  const button = await screen.findByRole(
    "button",
    { name: /Copy resume command/ },
    { timeout: LAZY_SURFACE_TIMEOUT_MS },
  );
  expect(button.getAttribute("aria-label")).toContain(
    "cd '/office/worktree' && claude --resume 'session-1'",
  );
  expect(screen.getByText("Run this command on office, in a POSIX-compatible shell.")).toBeTruthy();
});

describe("App model pricing entries", () => {
  it("exposes sidebar, inline notice, and overview KPI entry points in standalone mode and opens drawer", async () => {
    responses["/api/pricing/overview"] = {
      unmatchedModels: [
        {
          modelKey: "ollama/qwen3",
          displayModel: "ollama/qwen3",
          agents: ["opencode"],
          sessionCount: 2,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1500,
        },
      ],
      overrides: [
        {
          modelKey: "custom/model",
          displayModel: "custom/model",
          kind: "manual",
          targetModel: null,
          effectiveRates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          targetMissing: false,
          officialPriceAvailable: true,
          officialRates: { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 },
          updatedAt: 100,
        },
      ],
      attentionCount: 2,
    };
    responses["/api/pricing/models"] = { models: [], total: 0 };

    renderAppAt("/");

    const sidebarPricingButton = await screen.findByRole("button", { name: /Pricing/i });
    await waitFor(() => {
      expect(sidebarPricingButton.textContent).toContain("2");
    });
    expect(await screen.findByText("1 unmatched · 1 official updates")).toBeTruthy();
    expect(
      await screen.findByRole(
        "button",
        { name: "1 unmatched" },
        { timeout: LAZY_SURFACE_TIMEOUT_MS },
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss pricing notice" }));
    expect(screen.queryByText("1 unmatched · 1 official updates")).toBeNull();
    expect(screen.getByRole("button", { name: /Pricing/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1 unmatched" }));

    expect(
      await screen.findByRole(
        "heading",
        { name: "Model pricing" },
        { timeout: LAZY_SURFACE_TIMEOUT_MS },
      ),
    ).toBeTruthy();
    expect(await screen.findByText("ollama/qwen3")).toBeTruthy();
  });

  it("hides all pricing entry points and skips pricing requests in hub mode", async () => {
    responses["/api/config"] = { hubEnabled: true, window: { days: 30 } };
    responses["/api/nodes"] = { nodes: [] };
    responses["/api/pricing/overview"] = {
      unmatchedModels: [
        {
          modelKey: "ollama/qwen3",
          displayModel: "ollama/qwen3",
          agents: ["opencode"],
          sessionCount: 2,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1500,
        },
      ],
      overrides: [],
      attentionCount: 1,
    };

    renderAppAt("/");

    await screen.findByText("API value", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS });
    expect(screen.queryByRole("button", { name: /Pricing/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "1 unmatched" })).toBeNull();
    expect(screen.queryByText(/unmatched models missing pricing/i)).toBeNull();
    expect(requestedUrls.some((url) => url.includes("/api/pricing/"))).toBe(false);
  });
});
