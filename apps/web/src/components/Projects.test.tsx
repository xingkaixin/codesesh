import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiProjectGroup, ApiProjectPage, HubNodes } from "@codesesh/contract";
import { SAMPLE_DASHBOARD_DATA, SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import { createAgentCatalog } from "../lib/agents";
import type { IndexedSession } from "../lib/session-indexes";
import { createQueryWrapper } from "../test/query-wrapper";
import { ProjectDashboardView, ProjectsOverview } from "./Projects";

const projectA: ApiProjectGroup = {
  identityKind: "path",
  identityKey: "/workspace/alpha",
  displayName: "alpha",
  sources: ["codex"],
  sessionCount: 2,
  lastActivity: 200,
  messages: 10,
  tokens: 1_000,
  cost: 1.5,
  agentStats: [{ name: "codex", sessions: 2, messages: 10, tokens: 1_000, cost: 1.5 }],
};

const projectB: ApiProjectGroup = {
  identityKind: "path",
  identityKey: "/workspace/beta",
  displayName: "beta",
  sources: ["claudecode"],
  sessionCount: 9,
  lastActivity: 100,
  messages: 40,
  tokens: 5_000,
  cost: 12.0,
  agentStats: [{ name: "claudecode", sessions: 9, messages: 40, tokens: 5_000, cost: 12.0 }],
};

const defaultFirstPage: ApiProjectPage = {
  projects: [projectA],
  summary: { projects: 2, sessions: 11, tokens: 6_000, cost: 13.5, latestActivity: 200 },
  nextCursor: "cursor-page-2",
};

const multiNodeHub: HubNodes = {
  local: { enabled: true, sessions: 1 },
  nodes: [
    {
      id: "office",
      name: "Office Mac",
      version: "1.4.7",
      pairedAt: 1_000,
      lastSeen: 1_000,
      lastConfirmedAt: 1_000,
      revoked: false,
      incompleteSessions: 0,
      collectionComplete: true,
      queue: null,
      error: null,
      agents: {},
      ignoredSources: [],
    },
  ],
  tasks: [],
  version: "1.4.7",
  minimumWorkerVersion: "1.4.0",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function LocationSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="location-search">{location.search}</span>
      <button onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectsOverview", () => {
  it("delegates sorting to /api/projects and persists sort, sourceNodeId, and pagination in URL", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrls.push(url);
        if (url === "/api/nodes") {
          return Promise.resolve(jsonResponse(multiNodeHub));
        }
        const params = new URL(url, "http://localhost").searchParams;
        const sort = params.get("sort");
        const cursor = params.get("cursor");
        const sourceNodeId = params.get("sourceNodeId");
        if (sourceNodeId === "office") {
          return Promise.resolve(
            jsonResponse({
              projects: [projectB],
              summary: { projects: 1, sessions: 9, tokens: 5_000, cost: 12.0, latestActivity: 100 },
            }),
          );
        }
        if (sort === "cost") {
          return Promise.resolve(
            jsonResponse({
              projects: [projectB, projectA],
              nextCursor: cursor ? undefined : "cost-page-2",
              summary: defaultFirstPage.summary,
            }),
          );
        }
        if (cursor === "cursor-page-2" || cursor === "cursor-page-3") {
          return Promise.resolve(
            jsonResponse({
              projects: [projectB],
              nextCursor: cursor === "cursor-page-2" ? "cursor-page-3" : undefined,
              summary: defaultFirstPage.summary,
            }),
          );
        }
        return Promise.resolve(jsonResponse(defaultFirstPage));
      }),
    );

    const { client, Wrapper } = createQueryWrapper();
    client.setQueryData(["config"], { hubEnabled: true, window: { days: 7 } });
    client.setQueryData(["source-nodes"], multiNodeHub);

    render(
      <Wrapper>
        <MemoryRouter initialEntries={["/projects?range=7d"]}>
          <LocationSearch />
          <Routes>
            <Route
              path="/projects"
              element={
                <ProjectsOverview
                  window={{ from: 1, to: 2, days: 7 }}
                  agentCatalog={createAgentCatalog([])}
                  loading={false}
                  error={null}
                  onRetry={vi.fn()}
                />
              }
            />
            <Route path="*" element={<div>Project detail</div>} />
          </Routes>
        </MemoryRouter>
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("beta")).toBeTruthy());
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?range=7d&page=2&cursor=cursor-page-2",
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "beta" });

    // Changing sort sends sort=cost to the server and resets pagination in the URL.
    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    expect(
      requestedUrls.some((url) => url.includes("/api/projects?") && url.includes("sort=cost")),
    ).toBe(true);
    expect(screen.getByTestId("location-search").textContent).toBe("?range=7d&sort=cost");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("beta"),
      expect.stringContaining("alpha"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "beta" });
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    expect(screen.getByTestId("location-search").textContent).toContain("cursor=cursor-page-3");
    fireEvent.click(await screen.findByRole("link", { name: "beta" }));
    await screen.findByText("Project detail");
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Previous" }));
    expect(screen.getByTestId("location-search").textContent).toContain("cursor=cursor-page-2");
    fireEvent.click(await screen.findByRole("radio", { name: "Cost" }));

    // Selecting a source node persists sourceNodeId in URL and propagates to project links.
    fireEvent.change(screen.getByRole("combobox", { name: "Source node" }), {
      target: { value: "office" },
    });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(
      requestedUrls.some((url) => url.includes("sourceNodeId=office") && url.includes("sort=cost")),
    ).toBe(true);
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?range=7d&sort=cost&sourceNodeId=office",
    );
    expect(screen.getByRole("link", { name: "beta" }).getAttribute("href")).toBe(
      "/projects/path/%2Fworkspace%2Fbeta?sourceNodeId=office",
    );
  });

  it("resets an invalid cursor from the URL back to page 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const params = new URL(url, "http://localhost").searchParams;
        if (params.get("cursor") === "bad-cursor") {
          return Promise.resolve(jsonResponse({ error: "cursor invalid" }, 400));
        }
        return Promise.resolve(jsonResponse(defaultFirstPage));
      }),
    );

    const { Wrapper } = createQueryWrapper();
    render(
      <Wrapper>
        <MemoryRouter initialEntries={["/projects?sort=cost&page=2&cursor=bad-cursor"]}>
          <LocationSearch />
          <ProjectsOverview
            window={{ from: 1, to: 2, days: 7 }}
            agentCatalog={createAgentCatalog([])}
            loading={false}
            error={null}
            onRetry={vi.fn()}
          />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe("?sort=cost"),
    );
    expect(await screen.findByText("alpha")).toBeTruthy();
  });
});

describe("ProjectDashboardView", () => {
  it("filters both the project dashboard and timeline by sourceNodeId and persists it in URL", async () => {
    const dashboardUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/nodes") {
          return Promise.resolve(jsonResponse(multiNodeHub));
        }
        if (url.startsWith("/api/dashboard")) {
          dashboardUrls.push(url);
          return Promise.resolve(jsonResponse(SAMPLE_DASHBOARD_DATA));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    const localSession: IndexedSession = {
      ...SAMPLE_SESSION_HEAD,
      reference: { agentName: "codex", sessionId: "s-local" },
      title: "Local work session",
      time_created: 1_700_000_000_000,
      time_updated: 1_700_000_000_000,
    };
    const remoteSession: IndexedSession = {
      ...SAMPLE_SESSION_HEAD,
      reference: { sourceNodeId: "office", agentName: "codex", sessionId: "s-office" },
      title: "Office work session",
      time_created: 1_700_001_000_000,
      time_updated: 1_700_001_000_000,
    };

    const { client, Wrapper } = createQueryWrapper();
    client.setQueryData(["config"], { hubEnabled: true, window: { days: 7 } });
    client.setQueryData(["source-nodes"], multiNodeHub);

    render(
      <Wrapper>
        <MemoryRouter initialEntries={["/projects/path/%2Fworkspace%2Falpha"]}>
          <LocationSearch />
          <ProjectDashboardView
            project={projectA}
            loading={false}
            error={null}
            onRetry={vi.fn()}
            agentCatalog={createAgentCatalog([])}
            projectKey={projectA.identityKey}
            sessions={[localSession, remoteSession]}
            onChangeAgent={vi.fn()}
            timeWindow={{ from: 1_699_900_000_000, to: 1_700_100_000_000, days: 7 }}
            rangePreset="7d"
          />
        </MemoryRouter>
      </Wrapper>,
    );

    expect(screen.getByText("Local work session")).toBeTruthy();
    expect(screen.getByText("Office work session")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Source node" }), {
      target: { value: "office" },
    });

    await waitFor(() =>
      expect(dashboardUrls.some((url) => url.includes("sourceNodeId=office"))).toBe(true),
    );
    expect(screen.getByTestId("location-search").textContent).toBe("?sourceNodeId=office");
    expect(screen.queryByText("Local work session")).toBeNull();
    expect(screen.getByText("Office work session")).toBeTruthy();
  });
});
