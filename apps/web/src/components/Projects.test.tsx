import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiProjectGroup } from "../lib/api";
import { createAgentCatalog } from "../lib/agents";
import { createQueryWrapper } from "../test/query-wrapper";
import { ProjectsOverview } from "./Projects";

const PROJECT_COUNT_ABOVE_ARGUMENT_LIMIT = 200_000;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeProjects(count: number): ApiProjectGroup[] {
  return Array.from({ length: count }, (_, index) => ({
    identityKind: "path",
    identityKey: `/workspace/${index}`,
    displayName: `project-${index}`,
    sources: ["codex"],
    sessionCount: 1,
    lastActivity: index,
    messages: 1,
    tokens: 1,
    cost: 0,
    agentStats: [],
  }));
}

describe("ProjectsOverview project-count budget", () => {
  it("keeps rendering bounded above the JavaScript argument limit", () => {
    const { Wrapper } = createQueryWrapper();
    const projects = makeProjects(PROJECT_COUNT_ABOVE_ARGUMENT_LIMIT);

    render(
      <Wrapper>
        <MemoryRouter>
          <ProjectsOverview
            initialPage={{
              projects,
              summary: {
                projects: projects.length,
                sessions: projects.length,
                tokens: projects.length,
                cost: 0,
                latestActivity: projects.length - 1,
              },
            }}
            window={null}
            agentCatalog={createAgentCatalog([])}
            loading={false}
            error={null}
            onRetry={() => undefined}
          />
        </MemoryRouter>
      </Wrapper>,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(250);
    expect(screen.getAllByText("200,000")).toHaveLength(2);
  });

  it("replaces one bounded project page with the next", async () => {
    const { Wrapper } = createQueryWrapper();
    const firstProjects = makeProjects(100);
    const nextProject = makeProjects(1).map((project) => ({
      ...project,
      identityKey: "/workspace/next",
      displayName: "next-project",
    }));
    const summary = {
      projects: 101,
      sessions: 101,
      tokens: 101,
      cost: 0,
      latestActivity: 100,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projects: nextProject, summary }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Wrapper>
        <MemoryRouter>
          <ProjectsOverview
            initialPage={{ projects: firstProjects, summary, nextCursor: "next-page" }}
            window={{ from: 1, to: 2 }}
            agentCatalog={createAgentCatalog([])}
            loading={false}
            error={null}
            onRetry={() => undefined}
          />
        </MemoryRouter>
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByText("next-project")).toBeTruthy());
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("cursor=next-page");
    expect(screen.getByText(/Page 2/)).toBeTruthy();
  });
});
