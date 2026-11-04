import { render, screen, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../lib/api";
import { createQueryWrapper } from "../../test/query-wrapper";
import { NodeSummary } from "../app/SidebarFooter";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Drive node status responses over time without a Hub server.
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  fetchNodes: vi.fn(),
}));

const node = {
  id: "worker-one",
  name: "Office worker",
  version: "1.1.1",
  pairedAt: 1,
  lastSeen: Date.now(),
  lastConfirmedAt: null,
  revoked: false,
  incompleteSessions: 0,
  collectionComplete: true,
  queue: { batches: 3, bytes: 1024, oldestAt: 1 },
  error: null,
  agents: {},
  ignoredSources: [] as string[],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NodePanel", () => {
  it("keeps the sidebar count current and excludes revoked Workers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(node.lastSeen);
    vi.mocked(api.fetchNodes).mockResolvedValue({
      nodes: [
        node,
        { ...node, id: "revoked", revoked: true },
        { ...node, id: "offline", lastSeen: 1 },
      ],
      tasks: [],
      local: null,
      version: "1.1.1",
      minimumWorkerVersion: "1.1.1",
    });
    const { client, Wrapper } = createQueryWrapper();
    client.setQueryData(["config"], { window: {}, hubEnabled: true });
    render(<NodeSummary onManage={vi.fn()} />, { wrapper: Wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("Source nodes 1/2 online")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(65000));
    expect(screen.getByText("Source nodes 0/2 online")).toBeTruthy();
    vi.mocked(api.fetchNodes).mockRejectedValue(new Error("unreachable"));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText("Node status unavailable")).toBeTruthy();
  });
});
