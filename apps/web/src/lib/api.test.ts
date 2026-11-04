import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_DASHBOARD_DATA, SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import type { DashboardFilters } from "./api";
import { fetchDashboard, fetchSessionData, fetchSessions, subscribeSessionUpdates } from "./api";
import { createApiClient } from "./api-client";
import { resolveRemoteAccess } from "./remote-access";
import { createSessionUpdateSubscriber } from "./session-updates";

describe("fetchSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects cursor pages and publishes the first page", async () => {
    const nextSession = {
      ...SAMPLE_SESSION_HEAD,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ sessions: [SAMPLE_SESSION_HEAD], nextCursor: "next-page" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ sessions: [nextSession] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const onFirstPage = vi.fn();

    const result = await fetchSessions({}, undefined, { onFirstPage });

    expect(result.sessions).toEqual([SAMPLE_SESSION_HEAD, nextSession]);
    expect(onFirstPage).toHaveBeenCalledWith([SAMPLE_SESSION_HEAD]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions?limit=250",
      "/api/sessions?limit=250&cursor=next-page",
    ]);
  });

  it("restarts pagination when the server snapshot changes", async () => {
    const latestSession = {
      ...SAMPLE_SESSION_HEAD,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ sessions: [SAMPLE_SESSION_HEAD], nextCursor: "stale" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 409, statusText: "Conflict" })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ sessions: [latestSession] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const onFirstPage = vi.fn();

    const result = await fetchSessions({}, undefined, { onFirstPage });

    expect(result.sessions).toEqual([latestSession]);
    expect(onFirstPage).toHaveBeenNthCalledWith(1, [SAMPLE_SESSION_HEAD]);
    expect(onFirstPage).toHaveBeenNthCalledWith(2, [latestSession]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/sessions?limit=250");
  });
});

describe("remote access", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("stores the startup token, removes it from the URL, and authorizes fetch", async () => {
    window.history.replaceState(null, "", "/?access_token=remote-secret");
    const client = createApiClient(resolveRemoteAccess());
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_DASHBOARD_DATA),
    });
    vi.stubGlobal("fetch", fetchMock);

    await client.fetchDashboard(undefined, {});

    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("codesesh:remote-access-token")).toBe("remote-secret");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer remote-secret");
  });

  it("adds the startup token to the EventSource URL", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    window.history.replaceState(null, "", "/?access_token=remote-secret");
    const subscribe = createSessionUpdateSubscriber(resolveRemoteAccess());

    const unsubscribe = subscribe(() => {});

    expect(FakeEventSource.instances.at(-1)?.url).toBe("/api/events?access_token=remote-secret");
    unsubscribe();
  });
});

describe("fetchDashboard", () => {
  const timeZoneQuery = `&timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, DashboardFilters, string]>([
    ["unfiltered", {}, "/api/dashboard?days=7"],
    [
      "project",
      { project: { kind: "path", key: "/a/b" } },
      "/api/dashboard?days=7&projectKind=path&projectKey=%2Fa%2Fb",
    ],
    ["agent", { agent: "codex" }, "/api/dashboard?days=7&agent=codex"],
    [
      "project and agent together",
      { project: { kind: "path", key: "/a/b" }, agent: "codex" },
      "/api/dashboard?days=7&projectKind=path&projectKey=%2Fa%2Fb&agent=codex",
    ],
  ])("builds the %s query string", async (_name, filters, expected) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_DASHBOARD_DATA),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboard({ days: 7 }, filters);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expected + timeZoneQuery);
  });
});

describe("fetchSessionData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends paging options without forwarding them as fetch options", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchSessionData("codex", "session", {
      signal: controller.signal,
      messageCursor: "prefix+/=",
      messageLimit: 200,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/codex/session?messageCursor=prefix%2B%2F%3D&messageLimit=200",
      { signal: controller.signal },
    );
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly CLOSED = 2;

  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: string }) => void) {
    this.listeners[type] ??= [];
    this.listeners[type].push(cb);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

describe("subscribeSessionUpdates", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error("no EventSource created");
    return source;
  }

  it("calls onDisconnect once when the stream closes, and onReconnect when it recovers", () => {
    const onReconnect = vi.fn();
    const onDisconnect = vi.fn();
    subscribeSessionUpdates(() => {}, undefined, onReconnect, onDisconnect);

    latest().open();
    expect(onReconnect).not.toHaveBeenCalled();

    latest().fail();
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_200);
    latest().open();

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
