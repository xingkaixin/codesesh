/**
 * happy-dom has no 2D context and reports every element as 0×0, so a canvas
 * chart would never paint a single frame under test. This installs the smallest
 * environment the painters need: a recording context, a fixed layout box and a
 * ResizeObserver that does nothing.
 */
import { vi } from "vitest";

export interface StubbedCanvas {
  context: Record<string, ReturnType<typeof vi.fn>>;
  restore: () => void;
}

const CONTEXT_METHODS = [
  "arc",
  "arcTo",
  "beginPath",
  "clearRect",
  "clip",
  "closePath",
  "fill",
  "moveTo",
  "rect",
  "restore",
  "roundRect",
  "save",
  "setTransform",
  "stroke",
  "translate",
] as const;

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
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;

  return {
    context,
    restore: () => {
      getContext.mockRestore();
      rect.mockRestore();
      restoreSize();
      globalThis.ResizeObserver = previousObserver;
    },
  };
}
