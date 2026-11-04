import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { ScanStatusEvent } from "@codesesh/contract";
import * as api from "../lib/api";
import { ScanStatusProvider, useScanStatus, useScanStatusPublisher } from "./useScanStatus";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../lib/api", () => ({
  fetchScanStatus: vi.fn(),
}));

const sample: ScanStatusEvent = {
  type: "scan-status",
  active: true,
  phase: "scanning",
  pendingAgents: [],
  scanningAgents: ["claudecode"],
  completedAgents: [],
  agentStatuses: {},
  totalAgents: 1,
  updatedAt: 123,
  backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
  searchIndexMaintenance: {
    active: false,
    pendingAgents: [],
    completedAgents: [],
    failedAgents: [],
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ScanStatusProvider, null, children);
}

function useScanStatusSubject() {
  return {
    scanStatus: useScanStatus(),
    setScanStatus: useScanStatusPublisher(),
  };
}

describe("useScanStatus", () => {
  it("ignores events older than the current status", async () => {
    vi.mocked(api.fetchScanStatus).mockResolvedValue(sample);
    const { result } = renderHook(useScanStatusSubject, { wrapper });
    await waitFor(() => expect(result.current.scanStatus).toEqual(sample));

    const newer: ScanStatusEvent = {
      ...sample,
      active: false,
      phase: "idle",
      scanningAgents: [],
      updatedAt: 456,
    };
    result.current.setScanStatus(newer);
    await waitFor(() => expect(result.current.scanStatus).toEqual(newer));

    result.current.setScanStatus({ ...sample, updatedAt: 200 });
    await waitFor(() => expect(result.current.scanStatus).toEqual(newer));
  });

  it("applies a stale fetch snapshot only when no fresher event has arrived", async () => {
    let resolveFetch: (status: ScanStatusEvent) => void = () => {};
    vi.mocked(api.fetchScanStatus).mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const { result } = renderHook(useScanStatusSubject, { wrapper });

    const fresh: ScanStatusEvent = {
      ...sample,
      active: false,
      phase: "idle",
      scanningAgents: [],
      updatedAt: 456,
    };
    result.current.setScanStatus(fresh);
    await waitFor(() => expect(result.current.scanStatus).toEqual(fresh));

    resolveFetch(sample);
    await waitFor(() => expect(api.fetchScanStatus).toHaveBeenCalledTimes(1));
    expect(result.current.scanStatus).toEqual(fresh);
  });
});
