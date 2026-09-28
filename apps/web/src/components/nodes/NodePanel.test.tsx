import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../lib/api";
import { createQueryWrapper } from "../../test/query-wrapper";
import { NodePanel } from "./NodePanel";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise node actions and failure feedback with controlled server responses.
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  fetchNodes: vi.fn(),
  fetchSourceSessions: vi.fn(),
  requestRescan: vi.fn(),
  updateNode: vi.fn(),
  createPairingToken: vi.fn(),
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
  vi.clearAllMocks();
});

describe("NodePanel", () => {
  it("targets one node for rescanning and surfaces rejected management actions", async () => {
    panel();
    await screen.findByRole("heading", { name: "Office worker" });
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(api.requestRescan).toHaveBeenCalledWith(["worker-one"], []));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoke access" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    vi.mocked(api.updateNode).mockRejectedValueOnce(new Error("Hub disconnected"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(api.updateNode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Hub disconnected");
    expect(api.updateNode).toHaveBeenCalledWith("worker-one", "revoke");
  });

  it("shows an upgrade direction and applies the chosen source to session browsing", async () => {
    vi.mocked(api.fetchNodes).mockResolvedValue({
      nodes: [{ ...node, error: '"WORKER_TOO_NEW"' }],
      tasks: [],
      local: null,
      version: "1.1.1",
      minimumWorkerVersion: "1.1.1",
    });
    panel();
    await screen.findByText("Upgrade Hub first. Collection and uploads are paused.");
    fireEvent.click(screen.getByRole("button", { name: "Browse sessions" }));
    await waitFor(() =>
      expect(api.fetchSourceSessions).toHaveBeenCalledWith(
        "worker-one",
        undefined,
        expect.any(AbortSignal),
      ),
    );
  });
});
