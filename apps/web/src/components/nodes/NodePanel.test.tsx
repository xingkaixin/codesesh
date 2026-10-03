import { fireEvent, render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../lib/api";
import { createQueryWrapper } from "../../test/query-wrapper";
import { NodeStatusButton } from "./NodeStatusButton";
import { NodePanel } from "./NodePanel";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise node actions and failure feedback with controlled server responses.
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  fetchNodes: vi.fn(),
  fetchRescanHistory: vi.fn(),
  cancelRescan: vi.fn(),
  fetchSourceSessions: vi.fn(),
  requestRescan: vi.fn(),
  updateNode: vi.fn(),
  createPairingToken: vi.fn(),
  fetchPairingStatus: vi.fn(),
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
};

function panel() {
  const { client, Wrapper } = createQueryWrapper();
  client.setQueryData(["config"], { window: {}, hubEnabled: true });
  return render(
    <MemoryRouter>
      <NodePanel onClose={vi.fn()} />
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  vi.mocked(api.fetchPairingStatus).mockResolvedValue({ nodeId: null });
  vi.mocked(api.fetchNodes).mockResolvedValue({
    nodes: [node],
    tasks: [],
    local: null,
    version: "1.1.1",
    minimumWorkerVersion: "1.1.1",
  });
  vi.mocked(api.fetchSourceSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(api.requestRescan).mockResolvedValue(undefined);
  vi.mocked(api.updateNode).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NodePanel", () => {
  it("keeps the toolbar count current and excludes revoked Workers", async () => {
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
    render(<NodeStatusButton onClick={vi.fn()} />, { wrapper: Wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("1/2 online")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(65000));
    expect(screen.getByText("0/2 online")).toBeTruthy();
    vi.mocked(api.fetchNodes).mockRejectedValue(new Error("unreachable"));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(
      screen.getByRole("button", { name: "Source nodes: Node status unavailable" }),
    ).toBeTruthy();
  });
  it("marks an unchanged node offline as time passes and online after a heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(node.lastSeen);
    panel();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("Connected, uploading")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(65000));
    expect(screen.getByText("Offline. Saved history remains available.")).toBeTruthy();
    vi.mocked(api.fetchNodes).mockResolvedValue({
      nodes: [{ ...node, lastSeen: Date.now() }],
      tasks: [],
      local: null,
      version: "1.1.1",
      minimumWorkerVersion: "1.1.1",
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText("Connected, uploading")).toBeTruthy();
  });

  it("targets one node for rescanning and surfaces rejected management actions", async () => {
    panel();
    await screen.findByRole("heading", { name: "Office worker" });
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(api.requestRescan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rescan" }));
    await waitFor(() => expect(api.requestRescan).toHaveBeenCalledWith(["worker-one"], []));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoke access" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    vi.mocked(api.updateNode).mockRejectedValueOnce(new Error("Hub disconnected"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(api.updateNode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Confirm revoke" })).toBeNull(),
    );
    expect(api.updateNode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Hub disconnected");
    expect(api.updateNode).toHaveBeenCalledWith("worker-one", "revoke");
  });

  it("shows an upgrade direction without loading session content", async () => {
    vi.mocked(api.fetchNodes).mockResolvedValue({
      nodes: [{ ...node, error: '"WORKER_TOO_NEW"' }],
      tasks: [],
      local: null,
      version: "1.1.1",
      minimumWorkerVersion: "1.1.1",
    });
    panel();
    await screen.findByText("Upgrade Hub first. Collection and uploads are paused.");
    expect(api.fetchSourceSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("Sessions by source")).toBeNull();
  });

  it("selects an Agent only inside rescan confirmation and cancels safely", async () => {
    panel();
    await screen.findByRole("heading", { name: "Office worker" });
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rescan all Workers" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "codex" } });
    expect(api.requestRescan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rescan" }));
    await waitFor(() => expect(api.requestRescan).toHaveBeenCalledWith(["worker-one"], ["codex"]));
  });

  it("identifies failed Agents and marks old health reports as stale", async () => {
    vi.mocked(api.fetchNodes).mockResolvedValue({
      nodes: [
        {
          ...node,
          error: "SOURCE_OR_STORAGE_ERROR [codex]: permission denied",
          health: {
            reportedAt: Date.now() - 120000,
            collection: {
              activeAgent: "claudecode",
              lastSuccessAt: 123,
              errors: { codex: "permission denied" },
            },
          },
        },
      ],
      tasks: [],
      local: null,
      version: "1.1.1",
      minimumWorkerVersion: "1.1.1",
    });
    panel();
    await screen.findByText("Last reported state; Worker status may have changed.");
    expect(screen.getByText("Collection failed: codex")).toBeTruthy();
    expect(
      screen.getByText(
        "Check the affected Agent's source permissions and available disk space on the Worker.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Scanning claudecode")).toBeNull();
  });

  it("prioritizes a dispatched task and loads history only when requested", async () => {
    const request = {
      id: "active",
      agents: ["codex"],
      reason: "manual",
      requiredRevisions: {},
      createdAt: 1,
    };
    const active = { nodeId: node.id, request, status: "dispatched", progress: null };
    vi.mocked(api.fetchNodes).mockResolvedValue({
      nodes: [node],
      tasks: [
        { ...active, request: { ...request, id: "queued", createdAt: 2 }, status: "waiting" },
        active,
      ],
      local: null,
      version: "1.1.1",
      minimumWorkerVersion: "1.1.1",
    });
    vi.mocked(api.cancelRescan).mockResolvedValue(undefined);
    vi.mocked(api.fetchRescanHistory).mockResolvedValue({ tasks: [], nextCursor: null });
    panel();
    await screen.findByText("Dispatched to Worker · codex");
    const region = screen.getByRole("region", { name: "Rescan tasks" });
    expect(region.textContent!.indexOf("Dispatched to Worker")).toBeLessThan(
      region.textContent!.indexOf("Waiting for node"),
    );
    expect(api.fetchRescanHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued task" }));
    await waitFor(() => expect(api.cancelRescan).toHaveBeenCalledWith(node.id, "queued"));
    fireEvent.click(screen.getByRole("button", { name: "Task history" }));
    await screen.findByText("No completed tasks yet.");
    expect(api.fetchRescanHistory).toHaveBeenCalledWith(node.id, undefined);
  });

  it.each(["current", "stale", "offline", "other-task", "legacy", "uploading"])(
    "shows the recovery reason and only matching current scan counts (%s)",
    async (state) => {
      const scan = {
        id: state === "other-task" ? "old-task" : "recovery",
        agent: "codex",
        completed: 32,
        total: 96,
      };
      vi.mocked(api.fetchNodes).mockResolvedValue({
        nodes: [
          {
            ...node,
            lastSeen: state === "offline" ? 1 : Date.now(),
            health: {
              reportedAt: state === "stale" ? 1 : Date.now(),
              collection: {
                activeAgent: "codex",
                lastSuccessAt: null,
                errors: {},
                ...(state === "legacy" ? {} : { rescan: scan }),
              },
            },
          },
        ],
        tasks: [
          {
            nodeId: node.id,
            request: {
              id: "recovery",
              agents: [],
              reason: "hub-recovery",
              requiredRevisions: {},
              createdAt: 1,
            },
            status: state === "uploading" ? "uploading" : "running",
            progress: {
              id: "recovery",
              pendingAgents: state === "uploading" ? [] : ["codex"],
              targetSequence: state === "uploading" ? 192 : null,
              error: null,
            },
          },
        ],
        local: null,
        version: "1.2.5",
        minimumWorkerVersion: "1.1.1",
      });
      panel();
      await screen.findByText("Triggered by Hub recovery");
      expect(screen.queryByText("codex: 32 / 96 source items scanned") !== null).toBe(
        state === "current",
      );
      expect(screen.getByText("3 pending batches · 0.0 MB")).toBeTruthy();
      if (state === "uploading") {
        expect(screen.getByText("Waiting for upload confirmation · All agents")).toBeTruthy();
        expect(screen.queryByText("Pending Agents: codex")).toBeNull();
      } else {
        expect(screen.getByText("Pending Agents: codex")).toBeTruthy();
      }
    },
  );

  it("confirms pairing against the token rather than another newly connected node", async () => {
    vi.mocked(api.createPairingToken).mockResolvedValue({
      token: "paired-token",
      expiresInSeconds: 600,
    });
    vi.mocked(api.fetchPairingStatus).mockResolvedValue({ nodeId: "new-worker" });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Pair a Worker" }));
    await screen.findByText("Worker paired successfully");
    expect(screen.getByText("Source node: new-worker")).toBeTruthy();
    expect(api.fetchPairingStatus).toHaveBeenCalledWith("paired-token");
  });

  it("renews an expired token without closing the pairing flow", async () => {
    vi.mocked(api.createPairingToken)
      .mockResolvedValueOnce({ token: "expired-token", expiresInSeconds: 0 })
      .mockResolvedValueOnce({ token: "fresh-token", expiresInSeconds: 600 });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Pair a Worker" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate new token" }));
    await screen.findByDisplayValue("fresh-token");
    expect(screen.queryByRole("button", { name: "Generate new token" })).toBeNull();
  });

  it("requires explicit replacement and requests a token bound to the selected node", async () => {
    vi.mocked(api.createPairingToken).mockResolvedValue({
      token: "replacement-token",
      expiresInSeconds: 600,
    });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Replace Worker" }));
    expect(api.createPairingToken).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Keep this source identity, history, bookmarks, and titles. The old Worker's credentials stop working when the replacement pairs successfully.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create replacement token" }));
    await screen.findByDisplayValue("replacement-token");
    expect(api.createPairingToken).toHaveBeenCalledWith(node.id);
  });

  it("reports successful and failed token copies", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.mocked(api.createPairingToken).mockResolvedValue({
      token: "preview-token",
      expiresInSeconds: 600,
    });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Pair a Worker" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy token" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("preview-token");
    writeText.mockRejectedValue(new Error("Denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Copy failed");
  });
});
