import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, createRef, Profiler, useImperativeHandle, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { ScanStatusEvent } from "../lib/api";
import * as api from "../lib/api";
import { ScanStatusProvider, useScanStatus, useScanStatusPublisher } from "./useScanStatus";

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
  it("fetches the scan-status snapshot on mount", async () => {
    vi.mocked(api.fetchScanStatus).mockResolvedValue(sample);
    const { result } = renderHook(useScanStatusSubject, { wrapper });

    expect(result.current.scanStatus).toBeNull();
    await waitFor(() => expect(result.current.scanStatus).toEqual(sample));
  });

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

  it("stays null when the fetch fails", async () => {
    vi.mocked(api.fetchScanStatus).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(useScanStatusSubject, { wrapper });

    await waitFor(() => expect(api.fetchScanStatus).toHaveBeenCalledTimes(1));
    expect(result.current.scanStatus).toBeNull();
    errorSpy.mockRestore();
  });

  it("does not rerender unrelated siblings for 10,000 status updates", () => {
    const publisherRef = createRef<{ publish: (status: ScanStatusEvent) => void }>();
    const statusRender = vi.fn();
    const unrelatedRender = vi.fn();

    function Publisher() {
      const publish = useScanStatusPublisher();
      useImperativeHandle(publisherRef, () => ({ publish }), [publish]);
      return null;
    }
    function StatusConsumer() {
      useScanStatus();
      return null;
    }
    function UnrelatedSurface() {
      return null;
    }

    render(
      createElement(
        ScanStatusProvider,
        { initialStatus: sample },
        createElement(Publisher, { key: "publisher" }),
        createElement(
          Profiler,
          { key: "consumer", id: "status", onRender: statusRender },
          createElement(StatusConsumer),
        ),
        createElement(
          Profiler,
          { key: "unrelated", id: "unrelated", onRender: unrelatedRender },
          createElement(UnrelatedSurface),
        ),
      ),
    );

    const publish = publisherRef.current?.publish;
    if (!publish) throw new Error("Scan status publisher is not mounted");
    for (let index = 1; index <= 10_000; index += 1) {
      flushSync(() => publish({ ...sample, updatedAt: sample.updatedAt + index }));
    }

    expect(statusRender).toHaveBeenCalledTimes(10_001);
    expect(unrelatedRender).toHaveBeenCalledTimes(1);
  });
});
