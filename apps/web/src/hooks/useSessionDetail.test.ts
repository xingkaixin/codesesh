import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionDetail } from "@codesesh/contract";
import type { ViewState } from "../lib/view-state";
import * as api from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import { useSessionDetail } from "./useSessionDetail";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchSessionData: vi.fn(),
  logClientEvent: vi.fn(),
}));

const sessionView: ViewState = {
  mode: "session",
  activeAgentKey: "claudecode",
  activeSessionId: "claudecode/abc",
};

function makeSessionDetail(
  agentName: string,
  sessionId: string,
  overrides: Partial<SessionDetail> = {},
): SessionDetail {
  return {
    reference: { agentName, sessionId },
    title: sessionId,
    directory: "/workspace",
    time_created: 0,
    stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    messages: [],
    ...overrides,
  };
}

const sample = makeSessionDetail("claudecode", "abc");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type SessionDetailResult = ReturnType<typeof useSessionDetail>;

function sessionOf({ phase }: SessionDetailResult) {
  return phase.kind === "ready" ? phase.session : null;
}

function pagingOf({ phase }: SessionDetailResult) {
  return phase.kind === "ready" ? phase.messagePaging : undefined;
}

function renderSessionDetail(view: ViewState = sessionView) {
  const { client, Wrapper } = createQueryWrapper();
  return {
    client,
    ...renderHook(({ currentView }) => useSessionDetail(currentView), {
      initialProps: { currentView: view },
      wrapper: Wrapper,
    }),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useSessionDetail", () => {
  it("classifies a confirmed 404 as a missing session", async () => {
    vi.mocked(api.fetchSessionData).mockRejectedValue(new api.ApiRequestError("not found", 404));
    const { result } = renderSessionDetail();

    await waitFor(() => expect(result.current.phase).toEqual({ kind: "missing" }));
  });

  it.each([500, 503])("recovers from a %i detail response with a local retry", async (status) => {
    vi.mocked(api.fetchSessionData)
      .mockRejectedValueOnce(new api.ApiRequestError("server unavailable", status))
      .mockResolvedValueOnce(sample);
    const { result } = renderSessionDetail();

    await waitFor(() =>
      expect(result.current.phase).toEqual({
        kind: "load-failed",
        message: "server unavailable",
      }),
    );
    await act(() => result.current.refresh());

    await waitFor(() => expect(result.current.phase).toEqual({ kind: "ready", session: sample }));
  });

  it("keeps a loaded session on screen when a background refresh fails", async () => {
    vi.mocked(api.fetchSessionData)
      .mockResolvedValueOnce(sample)
      .mockRejectedValueOnce(new api.ApiRequestError("server unavailable", 503));
    const { client, result } = renderSessionDetail();
    await waitFor(() => expect(sessionOf(result.current)).toEqual(sample));

    await act(() =>
      client.invalidateQueries({
        queryKey: queryKeys.sessionDetail("claudecode", "claudecode/abc"),
      }),
    );

    expect(api.fetchSessionData).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toEqual({ kind: "ready", session: sample });
  });

  it("requests and merges only messages appended by a live update", async () => {
    const firstMessage = { id: "m1", role: "user" as const, time_created: 0, parts: [] };
    const nextMessage = { id: "m2", role: "user" as const, time_created: 0, parts: [] };
    const initial = makeSessionDetail("claudecode", "abc", {
      messages: [firstMessage],
      message_cursor: "cursor-1",
      message_update: "reset",
    });
    const appended = makeSessionDetail("claudecode", "abc", {
      messages: [nextMessage],
      message_cursor: "cursor-2",
      message_update: "append",
    });
    vi.mocked(api.fetchSessionData).mockResolvedValueOnce(initial).mockResolvedValueOnce(appended);
    const { client, result } = renderSessionDetail();
    await waitFor(() => expect(sessionOf(result.current)).toEqual(initial));

    await act(() =>
      client.invalidateQueries({
        queryKey: queryKeys.sessionDetail("claudecode", "claudecode/abc"),
        exact: true,
      }),
    );

    await waitFor(() =>
      expect(sessionOf(result.current)?.messages).toEqual([firstMessage, nextMessage]),
    );
    expect(api.fetchSessionData).toHaveBeenLastCalledWith(
      "claudecode",
      "claudecode/abc",
      expect.objectContaining({ messageCursor: "cursor-1" }),
    );
  });

  it("keeps the current route when an older request resolves last", async () => {
    const requestA = deferred<SessionDetail>();
    const requestB = deferred<SessionDetail>();
    const viewA = sessionView;
    const viewB: ViewState = {
      mode: "session",
      activeAgentKey: "codex",
      activeSessionId: "def",
    };
    const sessionA = makeSessionDetail("claudecode", "a");
    const sessionB = makeSessionDetail("codex", "b");
    vi.mocked(api.fetchSessionData).mockImplementation((_agent, sessionId) =>
      sessionId === viewA.activeSessionId ? requestA.promise : requestB.promise,
    );
    const { result, rerender } = renderSessionDetail(viewA);
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(1));

    rerender({ currentView: viewB });
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(2));
    await act(async () => requestB.resolve(sessionB));
    await waitFor(() => expect(sessionOf(result.current)).toEqual(sessionB));
    await act(async () => requestA.resolve(sessionA));

    expect({
      sessionId: sessionOf(result.current)?.reference.sessionId,
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

  it("does not let an old refresh overwrite a navigated session", async () => {
    const refreshRequest = deferred<SessionDetail>();
    const refreshedA = makeSessionDetail("claudecode", "a-refreshed");
    const sessionB = makeSessionDetail("codex", "b");
    const viewB: ViewState = {
      mode: "session",
      activeAgentKey: "codex",
      activeSessionId: "def",
    };
    vi.mocked(api.fetchSessionData)
      .mockResolvedValueOnce(sample)
      .mockReturnValueOnce(refreshRequest.promise)
      .mockResolvedValueOnce(sessionB);
    const { result, rerender } = renderSessionDetail();
    await waitFor(() => expect(sessionOf(result.current)).toEqual(sample));

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(api.fetchSessionData).toHaveBeenCalledTimes(2));
    rerender({ currentView: viewB });
    await waitFor(() => expect(sessionOf(result.current)).toEqual(sessionB));
    await act(async () => refreshRequest.resolve(refreshedA));
    await refreshPromise;

    expect(result.current.phase).toEqual({ kind: "ready", session: sessionB });
  });
});

it("retains loaded messages on a page failure, retries the prefix and resets rewritten content", async () => {
  const firstMessage = { id: "m1", role: "user" as const, time_created: 1, parts: [] };
  const secondMessage = { ...firstMessage, id: "m2" };
  const initial = {
    ...sample,
    messages: [firstMessage],
    message_cursor: "first",
    message_update: "reset" as const,
    message_total: 2,
  };
  const rewritten = {
    ...initial,
    messages: [{ ...firstMessage, id: "new" }],
    message_cursor: "new-prefix",
  };
  vi.mocked(api.fetchSessionData)
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("page unavailable"))
    .mockResolvedValueOnce({
      ...initial,
      messages: [secondMessage],
      message_cursor: "second",
      message_update: "append",
    })
    .mockResolvedValueOnce(rewritten);
  const { result } = renderSessionDetail();
  await waitFor(() => expect(sessionOf(result.current)).toEqual(initial));
  expect(api.fetchSessionData).toHaveBeenCalledTimes(1);
  expect(api.fetchSessionData).toHaveBeenLastCalledWith(
    "claudecode",
    "claudecode/abc",
    expect.objectContaining({ messageLimit: 200 }),
  );
  act(() => pagingOf(result.current)?.loadMore());
  await waitFor(() => expect(pagingOf(result.current)?.failed).toBe(true));
  expect(sessionOf(result.current)).toEqual(initial);
  act(() => pagingOf(result.current)?.loadMore());
  await waitFor(() =>
    expect(sessionOf(result.current)?.messages).toEqual([firstMessage, secondMessage]),
  );
  expect(pagingOf(result.current)).toBeUndefined();
  expect(api.fetchSessionData).toHaveBeenLastCalledWith(
    "claudecode",
    "claudecode/abc",
    expect.objectContaining({ messageCursor: "first", messageLimit: 200 }),
  );
  await act(() => result.current.refresh());
  await waitFor(() => expect(sessionOf(result.current)).toEqual(rewritten));
  expect(pagingOf(result.current)?.failed).toBe(false);
});
