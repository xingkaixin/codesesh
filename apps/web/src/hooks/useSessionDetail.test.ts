import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionData } from "../lib/api";
import type { ViewState } from "../lib/view-state";
import * as api from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderSessionDetail(view: ViewState = sessionView) {
  const { Wrapper } = createQueryWrapper();
  return renderHook(({ currentView }) => useSessionDetail(currentView), {
    initialProps: { currentView: view },
    wrapper: Wrapper,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionDetail", () => {
  it("loads the session for a session route", async () => {
    vi.mocked(api.fetchSessionData).mockResolvedValue(sample);
    const { result } = renderSessionDetail();

    await waitFor(() => expect(result.current.session).toEqual(sample));
    expect(result.current.sessionError).toBeNull();
    expect(api.fetchSessionData).toHaveBeenCalledWith(
      "claudecode",
      "claudecode/abc",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sets an error when the fetch fails", async () => {
    vi.mocked(api.fetchSessionData).mockRejectedValue(new Error("nope"));
    const { result } = renderSessionDetail();

    await waitFor(() => expect(result.current.sessionError).toBe("Session not found"));
    expect(result.current.session).toBeNull();
  });

  it("does not fetch for a non-session route", () => {
    const rootView: ViewState = { mode: "root", activeAgentKey: null, activeSessionSlug: null };
    const { result } = renderSessionDetail(rootView);

    expect(result.current.session).toBeNull();
    expect(api.fetchSessionData).not.toHaveBeenCalled();
  });

  it("refresh re-fetches the open session", async () => {
    vi.mocked(api.fetchSessionData).mockResolvedValue(sample);
    const { result } = renderSessionDetail();
    await waitFor(() => expect(result.current.session).toEqual(sample));

    const updated = { id: "abc", messages: [1] } as unknown as SessionData;
    vi.mocked(api.fetchSessionData).mockResolvedValue(updated);
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.session).toEqual(updated));
  });

  it("keeps the current route when an older request resolves last", async () => {
    const requestA = deferred<SessionData>();
    const requestB = deferred<SessionData>();
    const viewA = sessionView;
    const viewB: ViewState = {
      mode: "session",
      activeAgentKey: "codex",
      activeSessionSlug: "def",
    };
    const sessionA = { id: "a", messages: [] } as unknown as SessionData;
    const sessionB = { id: "b", messages: [] } as unknown as SessionData;
    vi.mocked(api.fetchSessionData).mockImplementation((_agent, sessionId) =>
      sessionId === viewA.activeSessionSlug ? requestA.promise : requestB.promise,
    );
    const { result, rerender } = renderSessionDetail(viewA);
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(1));

    rerender({ currentView: viewB });
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(2));
    await act(async () => requestB.resolve(sessionB));
    await waitFor(() => expect(result.current.session).toEqual(sessionB));
    await act(async () => requestA.resolve(sessionA));

    expect({
      sessionId: result.current.session?.id,
      lifecycle: vi
        .mocked(api.logClientEvent)
        .mock.calls.map(([event, fields]) => `${event}:${fields?.request_key}`),
    }).toEqual({
      sessionId: "b",
      lifecycle: [
        "session.open.start:claudecode/claudecode/abc",
        "session.open.cancel:claudecode/claudecode/abc",
        "session.open.start:codex/def",
        "session.open.done:codex/def",
      ],
    });
  });

  it("does not surface an aborted route request as an error", async () => {
    const viewB: ViewState = {
      mode: "session",
      activeAgentKey: "codex",
      activeSessionSlug: "def",
    };
    const sessionB = { id: "b", messages: [] } as unknown as SessionData;
    vi.mocked(api.fetchSessionData).mockImplementation((agent, _sessionId, options) => {
      if (agent === "codex") return Promise.resolve(sessionB);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const { result, rerender } = renderSessionDetail();
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(1));

    rerender({ currentView: viewB });
    await waitFor(() => expect(result.current.session).toEqual(sessionB));

    expect(result.current.sessionError).toBeNull();
    expect(api.logClientEvent).not.toHaveBeenCalledWith(
      "session.open.error",
      expect.objectContaining({ request_key: "claudecode/claudecode/abc" }),
    );
  });

  it("does not let a stale failure clear loading for the current request", async () => {
    const requestA = deferred<SessionData>();
    const requestB = deferred<SessionData>();
    const viewB: ViewState = {
      mode: "session",
      activeAgentKey: "codex",
      activeSessionSlug: "def",
    };
    const sessionB = { id: "b", messages: [] } as unknown as SessionData;
    vi.mocked(api.fetchSessionData).mockImplementation((_agent, sessionId) =>
      sessionId === sessionView.activeSessionSlug ? requestA.promise : requestB.promise,
    );
    const { result, rerender } = renderSessionDetail();
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(1));

    rerender({ currentView: viewB });
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(2));
    await act(async () => requestA.reject(new Error("stale failure")));

    expect(result.current.sessionLoading).toBe(true);
    expect(result.current.sessionError).toBeNull();
    await act(async () => requestB.resolve(sessionB));
    await waitFor(() => expect(result.current.sessionLoading).toBe(false));
    expect(result.current.session).toEqual(sessionB);
  });

  it("aborts without committing state after unmount", async () => {
    const request = deferred<SessionData>();
    vi.mocked(api.fetchSessionData).mockReturnValue(request.promise);
    const { unmount } = renderSessionDetail();
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(api.fetchSessionData).mock.calls[0]?.[2]?.signal;

    unmount();
    await act(async () => request.resolve(sample));

    expect(signal?.aborted).toBe(true);
    expect(api.logClientEvent).not.toHaveBeenCalledWith(
      "session.open.done",
      expect.objectContaining({ request_key: "claudecode/claudecode/abc" }),
    );
    expect(api.logClientEvent).not.toHaveBeenCalledWith(
      "session.open.error",
      expect.objectContaining({ request_key: "claudecode/claudecode/abc" }),
    );
  });

  it("does not let an old refresh overwrite a navigated session", async () => {
    const refreshRequest = deferred<SessionData>();
    const refreshedA = { id: "a-refreshed", messages: [] } as unknown as SessionData;
    const sessionB = { id: "b", messages: [] } as unknown as SessionData;
    const viewB: ViewState = {
      mode: "session",
      activeAgentKey: "codex",
      activeSessionSlug: "def",
    };
    vi.mocked(api.fetchSessionData)
      .mockResolvedValueOnce(sample)
      .mockReturnValueOnce(refreshRequest.promise)
      .mockResolvedValueOnce(sessionB);
    const { result, rerender } = renderSessionDetail();
    await waitFor(() => expect(result.current.session).toEqual(sample));

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(2));
    rerender({ currentView: viewB });
    await waitFor(() => expect(result.current.session).toEqual(sessionB));
    await act(async () => refreshRequest.resolve(refreshedA));
    await refreshPromise;

    expect(result.current.session).toEqual(sessionB);
    expect(result.current.sessionError).toBeNull();
  });
});
