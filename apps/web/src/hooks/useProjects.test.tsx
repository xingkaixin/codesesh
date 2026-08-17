import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiProjectGroup } from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
import { useProjectLookup } from "./useProjects";

const project = {
  identityKind: "path",
  identityKey: "/workspace/selected",
  displayName: "selected",
  sources: ["codex"],
  sessionCount: 1,
  lastActivity: 1,
  messages: 1,
  tokens: 1,
  cost: 0,
  agentStats: [],
} satisfies ApiProjectGroup;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useProjectLookup", () => {
  it("loads an exact project that is outside the catalog page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projects: [project],
          summary: {
            projects: 1,
            sessions: 1,
            tokens: 1,
            cost: 0,
            latestActivity: 1,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(
      () => useProjectLookup({ from: 1, to: 2 }, { kind: "path", key: project.identityKey }, []),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.project).toEqual(project));
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("limit=1");
    expect(requestUrl).toContain("projectKind=path");
    expect(requestUrl).toContain("projectKey=%2Fworkspace%2Fselected");
  });

  it("uses a project already present in the bounded page", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(
      () =>
        useProjectLookup({ from: 1, to: 2 }, { kind: "path", key: project.identityKey }, [project]),
      { wrapper: Wrapper },
    );

    expect(result.current.project).toBe(project);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
