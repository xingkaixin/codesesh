import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../lib/api";
import { stubAnimationFrames } from "../test/canvas-stub";
import type { SessionDetailToc } from "./session-detail/toc";
import { InteractiveReceipt } from "./InteractiveReceipt";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface MediaQueryControl {
  list: MediaQueryList;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  emit: (matches: boolean) => void;
}

interface ObserverControl {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

const restoreFonts: Array<() => void> = [];

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createSession(title: string): SessionDetail {
  return {
    reference: { agentName: "codex", sessionId: "session-1" },
    id: "session-1",
    slug: "codex/session-1",
    title,
    directory: "/repo",
    time_created: 1,
    time_updated: 2,
    stats: {
      message_count: 3,
      total_input_tokens: 120,
      total_output_tokens: 45,
      total_cost: 0.0123,
    },
    messages: [],
  };
}

function createToc(agentMessages = 1): SessionDetailToc {
  return {
    filterIds: new Set(["user", "agent_message", "tool:read"]),
    counts: {
      user: 1,
      agent_message: agentMessages,
      thinking: 0,
      plan: 0,
      tools_all: 1,
    },
    tools: [
      {
        id: "tool:read",
        toolKey: "read",
        label: "Read",
        count: 1,
        kind: "read",
      },
    ],
    maxToolCount: 1,
    totalUnitCount: agentMessages + 2,
  };
}

function installFonts(ready: Promise<unknown>) {
  const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready },
  });
  restoreFonts.push(() => {
    if (descriptor) Object.defineProperty(document, "fonts", descriptor);
    else Reflect.deleteProperty(document, "fonts");
  });
}

function createMediaQueryControl(query: string, matches: boolean): MediaQueryControl {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const list = {
    media: query,
    matches,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  const addEventListener = vi.fn(
    (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) listeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) listeners.delete(listener);
    },
  );
  Object.assign(list, { addEventListener, removeEventListener });

  return {
    list,
    addEventListener,
    removeEventListener,
    emit: (nextMatches) => {
      Object.defineProperty(list, "matches", { configurable: true, value: nextMatches });
      const event = { matches: nextMatches, media: query } as MediaQueryListEvent;
      for (const listener of listeners) {
        if (typeof listener === "function") listener.call(list, event as unknown as Event);
        else listener.handleEvent(event as unknown as Event);
      }
    },
  };
}

function createCanvasContext() {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    measureText: vi.fn((value: string) => ({ width: value.length * 6 })),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    transform: vi.fn(),
  };
}

function installEnvironment({
  fontsReady = Promise.resolve(),
  reducedMotion = false,
}: {
  fontsReady?: Promise<unknown>;
  reducedMotion?: boolean;
} = {}) {
  installFonts(fontsReady);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 320,
    height: 560,
    right: 320,
    bottom: 560,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  const context = createCanvasContext();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const frames = stubAnimationFrames();

  const mediaQueries: MediaQueryControl[] = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const control = createMediaQueryControl(
        query,
        query === "(prefers-reduced-motion: reduce)" ? reducedMotion : true,
      );
      mediaQueries.push(control);
      return control.list;
    }),
  );

  const resizeObservers: ObserverControl[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();

      constructor(_callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      unobserve() {}
    },
  );

  const mutationObservers: ObserverControl[] = [];
  vi.stubGlobal(
    "MutationObserver",
    class {
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();

      constructor(_callback: MutationCallback) {
        mutationObservers.push(this);
      }

      takeRecords() {
        return [];
      }
    },
  );

  return {
    context,
    frames,
    getContext,
    mediaQueries,
    mutationObservers,
    resizeObservers,
  };
}

async function flushFonts() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  while (restoreFonts.length > 0) restoreFonts.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("InteractiveReceipt lifecycle", () => {
  it("repaints payload updates without rebuilding lifecycle resources", async () => {
    const environment = installEnvironment();
    const { rerender } = render(
      <InteractiveReceipt session={createSession("Initial session")} toc={createToc()} />,
    );
    await flushFonts();

    expect(environment.resizeObservers).toHaveLength(1);
    expect(environment.mutationObservers).toHaveLength(1);
    expect(environment.mediaQueries).toHaveLength(2);
    expect(environment.frames.pendingCount()).toBe(1);
    expect(environment.getContext).toHaveBeenCalledTimes(2);
    const scheduledFrames = vi.mocked(window.requestAnimationFrame).mock.calls.length;

    environment.context.fillText.mockClear();
    rerender(<InteractiveReceipt session={createSession("Updated session")} toc={createToc(2)} />);

    expect(environment.getContext).toHaveBeenCalledTimes(3);
    expect(environment.context.fillText.mock.calls.map(([value]) => value)).toContain(
      "UPDATED SESSION",
    );
    expect(environment.resizeObservers).toHaveLength(1);
    expect(environment.mutationObservers).toHaveLength(1);
    expect(environment.mediaQueries).toHaveLength(2);
    expect(environment.frames.pendingCount()).toBe(1);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(scheduledFrames);
    expect(environment.resizeObservers[0]?.disconnect).not.toHaveBeenCalled();
    expect(environment.mutationObservers[0]?.disconnect).not.toHaveBeenCalled();
  });

  it("keeps only the live StrictMode instance after fonts finish loading", async () => {
    const fonts = createDeferred<void>();
    const environment = installEnvironment({ fontsReady: fonts.promise });
    const { rerender } = render(
      <StrictMode>
        <InteractiveReceipt session={createSession("Initial session")} toc={createToc()} />
      </StrictMode>,
    );

    rerender(
      <StrictMode>
        <InteractiveReceipt session={createSession("Latest session")} toc={createToc(2)} />
      </StrictMode>,
    );
    expect(environment.frames.pendingCount()).toBe(0);

    await act(async () => {
      fonts.resolve();
      await fonts.promise;
    });

    expect(environment.frames.pendingCount()).toBe(1);
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(environment.context.fillText.mock.calls.map(([value]) => value)).toContain(
      "LATEST SESSION",
    );
  });

  it("draws one stable frame and exits when reduced motion is requested", async () => {
    const environment = installEnvironment({ reducedMotion: true });
    const { container } = render(
      <InteractiveReceipt session={createSession("Reduced motion")} toc={createToc()} />,
    );
    await flushFonts();

    const canvas = container.querySelector("canvas");
    const hitSurface = screen.getByLabelText(
      "Interactive thermal receipt with Verlet paper simulation",
    );
    expect(environment.frames.pendingCount()).toBe(1);

    act(() => environment.frames.runNext(performance.now() + 20));

    expect(environment.frames.pendingCount()).toBe(0);
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(canvas?.style.visibility).toBe("visible");
    expect(hitSurface.style.visibility).toBe("hidden");
  });

  it("releases observers, listeners, and the active frame on unmount", async () => {
    const environment = installEnvironment();
    const view = render(
      <InteractiveReceipt session={createSession("Cleanup")} toc={createToc()} />,
    );
    await flushFonts();

    const hitSurface = screen.getByLabelText(
      "Interactive thermal receipt with Verlet paper simulation",
    );
    const setPointerCapture = vi.fn();
    Object.defineProperty(hitSurface, "setPointerCapture", { value: setPointerCapture });

    expect(environment.frames.pendingCount()).toBe(1);
    view.unmount();

    expect(environment.frames.pendingCount()).toBe(0);
    expect(window.cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(environment.resizeObservers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(environment.mutationObservers[0]?.disconnect).toHaveBeenCalledOnce();
    for (const media of environment.mediaQueries) {
      expect(media.removeEventListener).toHaveBeenCalledOnce();
    }

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("resize"));
    for (const media of environment.mediaQueries) media.emit(true);
    const pointerDown = new Event("pointerdown");
    Object.defineProperties(pointerDown, {
      button: { value: 0 },
      clientX: { value: 25 },
      clientY: { value: 44 },
      pointerId: { value: 1 },
    });
    hitSurface.dispatchEvent(pointerDown);
    expect(environment.frames.pendingCount()).toBe(0);
    expect(setPointerCapture).not.toHaveBeenCalled();
  });
});
