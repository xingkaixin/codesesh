import { useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjects, type ApiProjectGroup, type ApiProjectPage } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import { useProjectLookup, useProjectPagination } from "./useProjects";

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

const firstPage: ApiProjectPage = {
  projects: [project],
  summary: { projects: 101, sessions: 101, tokens: 101, cost: 0, latestActivity: 1 },
  nextCursor: "old-cursor",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

describe("useProjectPagination", () => {
  it.each([true, false])(
    "recovers a stale live page with an active first page: %s",
    async (firstPageActive) => {
      const window = { from: 1, to: 2 };
      const secondPage = {
        ...firstPage,
        projects: [{ ...project, identityKey: "/workspace/second", displayName: "second" }],
        nextCursor: undefined,
      };
      let snapshotChanged = false;
      const requestCursors: Array<string | null> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
          requestCursors.push(cursor);
          if (cursor === "old-cursor" && snapshotChanged) {
            return Promise.resolve(jsonResponse({ error: "snapshot changed" }, 409));
          }
          return Promise.resolve(
            jsonResponse(
              cursor
                ? secondPage
                : { ...firstPage, nextCursor: snapshotChanged ? "new-cursor" : "old-cursor" },
            ),
          );
        }),
      );
      const { client, Wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () => {
          const initial = useQuery({
            queryKey: queryKeys.projectPage(window),
            queryFn: ({ signal }) => fetchProjects(window, { signal }),
            initialData: firstPage,
            enabled: firstPageActive,
            staleTime: Infinity,
          });
          return useProjectPagination(window, initial.data);
        },
        { wrapper: Wrapper },
      );

      act(() => result.current.next());
      await waitFor(() => expect(result.current.page?.projects).toEqual(secondPage.projects));
      expect(result.current.pageNumber).toBe(2);

      snapshotChanged = true;
      await act(() =>
        client.invalidateQueries({
          queryKey: queryKeys.projectWindow(window),
          refetchType: "active",
        }),
      );

      await waitFor(() => expect(result.current.page?.nextCursor).toBe("new-cursor"));
      expect(result.current.pageNumber).toBe(1);
      expect(result.current.error).toBeNull();

      act(() => result.current.next());
      await waitFor(() => expect(result.current.pageNumber).toBe(2));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(requestCursors.at(-1)).toBe("new-cursor");
      expect(result.current.page?.projects).toEqual(secondPage.projects);
    },
  );

  it("keeps non-stale failures on their page for retry", async () => {
    const requestCursors: Array<string | null> = [];
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestCursors.push(new URL(url, "http://localhost").searchParams.get("cursor"));
        return Promise.resolve(
          failing
            ? jsonResponse({ error: "unavailable" }, 503)
            : jsonResponse({ ...firstPage, nextCursor: undefined }),
        );
      }),
    );
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useProjectPagination({ from: 1, to: 2 }, firstPage), {
      wrapper: Wrapper,
    });

    act(() => result.current.next());
    await waitFor(() => expect(result.current.error).toContain("503"));
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.canPrevious).toBe(true);

    failing = false;
    await act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.pageNumber).toBe(2);
    expect(requestCursors).toEqual(["old-cursor", "old-cursor"]);
  });
});
