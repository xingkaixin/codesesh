import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionData } from "../lib/api";
import type { ViewState } from "../lib/view-state";
import * as api from "../lib/api";
import { useSessionDetail } from "./useSessionDetail";

vi.mock("../lib/api", () => ({
  fetchSessionData: vi.fn(),
  logClientEvent: vi.fn(),
}));

const sessionView: ViewState = {
  mode: "session",
  activeAgentKey: "claudecode",
  activeSessionSlug: "claudecode/abc",
};

const sample = { id: "abc", messages: [] } as unknown as SessionData;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionDetail", () => {
  it("loads the session for a session route", async () => {
    vi.mocked(api.fetchSessionData).mockResolvedValue(sample);
    const { result } = renderHook(() => useSessionDetail(sessionView));

    await waitFor(() => expect(result.current.session).toEqual(sample));
    expect(result.current.sessionError).toBeNull();
    expect(api.fetchSessionData).toHaveBeenCalledWith("claudecode", "claudecode/abc");
  });

  it("sets an error when the fetch fails", async () => {
    vi.mocked(api.fetchSessionData).mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useSessionDetail(sessionView));

    await waitFor(() => expect(result.current.sessionError).toBe("Session not found"));
    expect(result.current.session).toBeNull();
  });

  it("does not fetch for a non-session route", () => {
    const rootView: ViewState = { mode: "root", activeAgentKey: null, activeSessionSlug: null };
    const { result } = renderHook(() => useSessionDetail(rootView));

    expect(result.current.session).toBeNull();
    expect(api.fetchSessionData).not.toHaveBeenCalled();
  });

  it("refresh re-fetches the open session", async () => {
    vi.mocked(api.fetchSessionData).mockResolvedValue(sample);
    const { result } = renderHook(() => useSessionDetail(sessionView));
    await waitFor(() => expect(result.current.session).toEqual(sample));

    const updated = { id: "abc", messages: [1] } as unknown as SessionData;
    vi.mocked(api.fetchSessionData).mockResolvedValue(updated);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.session).toEqual(updated);
  });
});
