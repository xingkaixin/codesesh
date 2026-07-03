import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ScanStatusEvent } from "../lib/api";
import * as api from "../lib/api";
import { useScanStatus } from "./useScanStatus";

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
  backfill: { active: false, pendingAgents: [], completedAgents: [] },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useScanStatus", () => {
  it("fetches the scan-status snapshot on mount", async () => {
    vi.mocked(api.fetchScanStatus).mockResolvedValue(sample);
    const { result } = renderHook(() => useScanStatus());

    expect(result.current.scanStatus).toBeNull();
    await waitFor(() => expect(result.current.scanStatus).toEqual(sample));
  });

  it("ignores events older than the current status", async () => {
    vi.mocked(api.fetchScanStatus).mockResolvedValue(sample);
    const { result } = renderHook(() => useScanStatus());
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
    const { result } = renderHook(() => useScanStatus());

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

  it("stays null when the fetch fails", async () => {
    vi.mocked(api.fetchScanStatus).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useScanStatus());

    await waitFor(() => expect(api.fetchScanStatus).toHaveBeenCalledTimes(1));
    expect(result.current.scanStatus).toBeNull();
    errorSpy.mockRestore();
  });
});
