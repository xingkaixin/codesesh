import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import { useSessionAliasMutations } from "./useSessionAliasMutations";

vi.mock("../lib/api", () => ({
  deleteSessionAlias: vi.fn(),
  upsertSessionAlias: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionAliasMutations", () => {
  it("saves an alias and invalidates its consumers", async () => {
    vi.mocked(api.upsertSessionAlias).mockResolvedValue();
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const { client, Wrapper } = createQueryWrapper();
    const detailKey = queryKeys.sessionDetail("codex", "session-1");
    const dashboardKey = queryKeys.dashboard({}, {});
    const searchKey = queryKeys.search("query", {});
    client.setQueryData(detailKey, { id: "session-1" });
    client.setQueryData(dashboardKey, { totals: {} });
    client.setQueryData(searchKey, []);
    const { result } = renderHook(() => useSessionAliasMutations(refreshSnapshot), {
      wrapper: Wrapper,
    });

    await act(() =>
      result.current.saveAlias({ agentKey: "codex", sessionId: "session-1" }, "Renamed"),
    );

    expect(api.upsertSessionAlias).toHaveBeenCalledWith("codex", "session-1", "Renamed");
    expect(refreshSnapshot).toHaveBeenCalledOnce();
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(searchKey)?.isInvalidated).toBe(true);
  });

  it("removes an alias before refreshing consumers", async () => {
    vi.mocked(api.deleteSessionAlias).mockResolvedValue();
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionAliasMutations(refreshSnapshot), {
      wrapper: Wrapper,
    });

    await act(() => result.current.removeAlias({ agentKey: "claudecode", sessionId: "session-2" }));

    expect(api.deleteSessionAlias).toHaveBeenCalledWith("claudecode", "session-2");
    expect(refreshSnapshot).toHaveBeenCalledOnce();
  });
});
