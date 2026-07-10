import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSearchResults,
  fetchSessionData,
  fetchSessions,
  subscribeSessionUpdates,
} from "./api";

describe("fetchSessionData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchSessionData("codex", "session", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/codex/session", {
      signal: controller.signal,
    });
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
      json: () => Promise.resolve({}),
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

    latest().emit("sessions-updated", { type: "sessions-updated", newSessions: 1 });
    latest().emit("scan-status", { type: "scan-status", active: true });

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ newSessions: 1 }));
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
});
