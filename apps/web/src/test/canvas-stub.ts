/**
 * happy-dom has no 2D context and reports every element as 0×0, so a canvas
 * chart would never paint a single frame under test. This installs the smallest
 * environment the painters need: a recording context, a fixed layout box and a
 * controllable ResizeObserver.
 */
import { vi } from "vitest";

const CONTEXT_METHODS = [
  "arc",
  "arcTo",
  "beginPath",
  "clearRect",
  "clip",
  "closePath",
  "fill",
  "fillRect",
  "moveTo",
  "rect",
  "restore",
  "roundRect",
  "save",
  "setTransform",
  "stroke",
  "translate",
] as const;

type ContextMethod = (typeof CONTEXT_METHODS)[number];

export interface StubbedCanvas {
  context: Record<ContextMethod, ReturnType<typeof vi.fn>>;
  resize: () => void;
  restore: () => void;
}

export function stubAnimationFrames() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    pending.delete(id);
  });

  return {
    pendingCount: () => pending.size,
    runNext: (time: number) => {
      const next = pending.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) throw new Error("No animation frame is pending");
      pending.delete(next[0]);
      next[1](time);
    },
    restore: () => {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

function defineSize(size: { width: number; height: number }): () => void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const previous = {
    clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => size.width });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => size.height });

  return () => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  };
}

export function stubCanvas(size: { width: number; height: number }): StubbedCanvas {
  const context = Object.fromEntries(
    CONTEXT_METHODS.map((name) => [name, vi.fn()]),
  ) as StubbedCanvas["context"];

  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: size.width,
    height: size.height,
    right: size.width,
    bottom: size.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const restoreSize = defineSize(size);

  const previousObserver = globalThis.ResizeObserver;
  let resizeCallback: ResizeObserverCallback | undefined;
  let resizeObserver: ResizeObserver | undefined;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
      resizeObserver = this as unknown as ResizeObserver;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;

  return {
    context,
    resize: () => resizeCallback?.([], resizeObserver!),
    restore: () => {
      getContext.mockRestore();
      rect.mockRestore();
      restoreSize();
      globalThis.ResizeObserver = previousObserver;
    },
  };
}
