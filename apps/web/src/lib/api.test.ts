import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAMPLE_DASHBOARD_DATA,
  SAMPLE_SESSIONS_UPDATED_EVENT,
  SAMPLE_SESSION_HEAD,
} from "@codesesh/core/test-fixtures";
import type { DashboardFilters } from "./api";
import {
  ApiRequestError,
  fetchAgents,
  fetchConfig,
  fetchDashboard,
  fetchProjects,
  fetchSearchResults,
  fetchSessionData,
  fetchSessions,
  subscribeSessionUpdates,
} from "./api";
import { createApiClient } from "./api-client";
import { createClientTelemetry } from "./client-telemetry";
import { resolveRemoteAccess } from "./remote-access";
import { createSessionUpdateSubscriber } from "./session-updates";

describe("abortable list requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["config", (signal: AbortSignal) => fetchConfig({ signal })],
    ["agents", (signal: AbortSignal) => fetchAgents(undefined, { signal })],
    ["projects", (signal: AbortSignal) => fetchProjects(undefined, { signal })],
    ["sessions", (signal: AbortSignal) => fetchSessions({}, { signal })],
  ])("forwards the abort signal for %s", async (_name, request) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await request(controller.signal);

    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });
});

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

  it("authorizes telemetry without using the beacon path", () => {
    window.history.replaceState(null, "", "/?access_token=remote-secret");
    const telemetry = createClientTelemetry(resolveRemoteAccess());
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const sendBeacon = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal("fetch", fetchMock);

    telemetry.logClientEvent("app.ready");

    expect(sendBeacon).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer remote-secret");
  });

  it("keeps each client bound to its startup credentials", async () => {
    window.history.replaceState(null, "", "/?access_token=first-secret");
    const firstClient = createApiClient(resolveRemoteAccess());
    window.history.replaceState(null, "", "/?access_token=second-secret");
    const secondClient = createApiClient(resolveRemoteAccess());
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_DASHBOARD_DATA),
    });
    vi.stubGlobal("fetch", fetchMock);

    await firstClient.fetchDashboard(undefined, {});
    await secondClient.fetchDashboard(undefined, {});

    const headers = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Authorization"),
    );
    expect(headers).toEqual(["Bearer first-secret", "Bearer second-secret"]);
  });
});

describe("fetchDashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes the dashboard response as-is", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_DASHBOARD_DATA),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDashboard(undefined, {});

    expect(result).toEqual(SAMPLE_DASHBOARD_DATA);
  });

  it("uses days=0 without expanding all-time into thousands of daily buckets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_DASHBOARD_DATA),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboard({ from: 0, days: 0 }, {});

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/dashboard?days=0");
  });

  it("sends exact bounds without a redundant days value", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_DASHBOARD_DATA),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboard({ from: 10, to: 20, days: 7 }, {});

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/dashboard?from=1970-01-01T00%3A00%3A00.010Z&to=1970-01-01T00%3A00%3A00.020Z",
    );
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

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
  });
});

describe("fetchSessionData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchSessionData("codex", "session", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/codex/session", {
      signal: controller.signal,
    });
  });

  it("sends an opaque message cursor without forwarding it as a fetch option", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchSessionData("codex", "session", {
      signal: controller.signal,
      messageCursor: "prefix+/=",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/codex/session?messageCursor=prefix%2B%2F%3D",
      { signal: controller.signal },
    );
  });

  it("sends the session-detail operation identifier as a request header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchSessionData("codex", "session", { operationId: "detail-operation" });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/codex/session", {
      signal: undefined,
      headers: { "X-CodeSesh-Operation-ID": "detail-operation" },
    });
  });

  it("exposes failed response status through ApiRequestError", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSessionData("codex", "missing")).rejects.toEqual(
      expect.objectContaining({
        message: "GET /api/sessions/codex/missing failed: 404 Not Found",
        status: 404,
      }),
    );
    await expect(fetchSessionData("codex", "missing")).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe("project identity request filters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["sessions", () => fetchSessions({ projectKind: "path", projectKey: "/workspace/app" })],
    [
      "search",
      () => fetchSearchResults("error", { projectKind: "path", projectKey: "/workspace/app" }),
    ],
  ])("sends both identity fields for %s requests", async (_name, request) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await request();

    const url = new URL(fetchMock.mock.calls[0]![0], "http://localhost");
    expect(url.searchParams.get("projectKind")).toBe("path");
    expect(url.searchParams.get("projectKey")).toBe("/workspace/app");
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

  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) {
      cb({ data: JSON.stringify(data) });
    }
  }

  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  interrupt() {
    this.readyState = FakeEventSource.CONNECTING;
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

  it("delivers sessions-updated and scan-status events", () => {
    const onUpdate = vi.fn();
    const onScanStatus = vi.fn();
    subscribeSessionUpdates(onUpdate, onScanStatus);

    latest().emit("sessions-updated", SAMPLE_SESSIONS_UPDATED_EVENT);
    latest().emit("scan-status", { type: "scan-status", active: true });

    expect(onUpdate).toHaveBeenCalledWith(SAMPLE_SESSIONS_UPDATED_EVENT);
    expect(onScanStatus).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
  });

  it("does not call onReconnect on the first connection open", () => {
    const onReconnect = vi.fn();
    subscribeSessionUpdates(() => {}, undefined, onReconnect);

    latest().open();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("rebuilds the connection with exponential backoff up to the 30s cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    subscribeSessionUpdates(() => {});

    expect(FakeEventSource.instances).toHaveLength(1);

    latest().fail();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    latest().fail();
    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().fail();
    vi.advanceTimersByTime(4000);
    expect(FakeEventSource.instances).toHaveLength(4);

    latest().fail();
    vi.advanceTimersByTime(8000);
    expect(FakeEventSource.instances).toHaveLength(5);

    latest().fail();
    vi.advanceTimersByTime(16000);
    expect(FakeEventSource.instances).toHaveLength(6);

    latest().fail();
    vi.advanceTimersByTime(30000);
    expect(FakeEventSource.instances).toHaveLength(7);

    vi.spyOn(Math, "random").mockRestore();
  });

  it("keeps retry delay within +/-20% jitter of the exponential base", () => {
    subscribeSessionUpdates(() => {});
    latest().fail();

    const scheduled = vi.getTimerCount();
    expect(scheduled).toBe(1);

    vi.advanceTimersByTime(799);
    const before = FakeEventSource.instances.length;
    vi.advanceTimersByTime(1);
    const after = FakeEventSource.instances.length;

    expect(before).toBe(1);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("does not reconnect after unsubscribe", () => {
    const unsubscribe = subscribeSessionUpdates(() => {});
    const first = latest();

    unsubscribe();
    expect(first.closed).toBe(true);

    first.fail();
    vi.advanceTimersByTime(60_000);

    expect(FakeEventSource.instances).toHaveLength(1);
  });

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

  it("reports native reconnect interruptions only after the delay threshold", () => {
    const onDisconnect = vi.fn();
    subscribeSessionUpdates(() => {}, undefined, undefined, onDisconnect);

    latest().open();
    latest().interrupt();
    vi.advanceTimersByTime(4_999);

    expect(onDisconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending disconnect notice when native reconnect succeeds", () => {
    const onReconnect = vi.fn();
    const onDisconnect = vi.fn();
    subscribeSessionUpdates(() => {}, undefined, onReconnect, onDisconnect);

    latest().open();
    latest().interrupt();
    vi.advanceTimersByTime(4_999);
    latest().open();
    vi.advanceTimersByTime(1);

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
