import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig, SessionsUpdatedEvent } from "../lib/api";
import type { ViewState } from "../lib/view-state";
import * as api from "../lib/api";
import { useLiveSync } from "./useLiveSync";

let sessionsCb: ((event: SessionsUpdatedEvent) => void) | undefined;

vi.mock("../lib/api", () => ({
  subscribeSessionUpdates: vi.fn((onSessions: (event: SessionsUpdatedEvent) => void) => {
    sessionsCb = onSessions;
    return () => {};
  }),
}));

const appConfig = { window: { from: "a", to: "b" } } as unknown as AppConfig;
const rootView = { mode: "root", activeAgentKey: null, activeSessionSlug: null } as ViewState;

function makeDeps() {
  return {
    appConfig,
    viewState: rootView,
    applySessionsLiveEvent: vi.fn(),
    refreshAgents: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    refreshDashboard: vi.fn().mockResolvedValue(undefined),
    refreshProjectDashboard: vi.fn().mockResolvedValue(undefined),
    refreshSessionDetail: vi.fn().mockResolvedValue(undefined),
    refreshSearch: vi.fn().mockResolvedValue(undefined),
    setScanStatus: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionsCb = undefined;
});

describe("useLiveSync", () => {
  it("subscribes on mount", () => {
    renderHook(() => useLiveSync(makeDeps()));
    expect(api.subscribeSessionUpdates).toHaveBeenCalledOnce();
  });

  it("fans out refreshes on a session event", async () => {
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCb?.({ newSessions: 0 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });

    expect(deps.refreshAgents).toHaveBeenCalled();
    expect(deps.refreshDashboard).toHaveBeenCalled();
    expect(deps.refreshSearch).toHaveBeenCalled();
  });

  it("surfaces liveNotice when new sessions arrive", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCb?.({ newSessions: 3 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.liveNotice).toContain("3"));
  });
});
