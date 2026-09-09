import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachFluidHover } from "../../../shared/fluid-hover";

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const group = document.createElement("div");
  group.dataset.fluidHover = "x";
  group.innerHTML =
    '<button data-fluid-item aria-checked="true">First</button><button data-fluid-item>Second</button><button>Separate action</button>';
  document.body.append(group);
  const [first, second, separate] = Array.from(group.querySelectorAll("button")) as [
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
  ];
  vi.spyOn(group, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 40));
  Object.defineProperties(group, { offsetWidth: { value: 300 }, offsetHeight: { value: 40 } });
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 80, 40));
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 80, 40));
  dispose = attachFluidHover(group);
  return { group, first, second, separate };
}

async function move(target: HTMLElement, x: number, pointerType = "mouse") {
  target.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, pointerType, clientX: x, clientY: 20 }),
  );
  await vi.advanceTimersByTimeAsync(20);
}

describe("fluid hover", () => {
  it("glides across gaps without changing selection or forwarding gap clicks", async () => {
    const { group, first, second } = fixture();
    const click = vi.fn();
    first.addEventListener("click", click);
    second.addEventListener("click", click);
    await move(first, 20);
    await move(group, 96);
    expect(second.hasAttribute("data-fluid-active")).toBe(true);
    expect(group.hasAttribute("data-fluid-travel")).toBe(true);
    group.click();
    expect(click).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).not.toBe(second);
  });

  it("does not highlight disabled, hidden or unrelated controls", async () => {
    const { group, first, second, separate } = fixture();
    second.disabled = true;
    await move(group, 130);
    expect(group.hasAttribute("data-fluid-visible")).toBe(false);
    second.disabled = false;
    vi.mocked(second.getBoundingClientRect).mockReturnValue(new DOMRect());
    group.dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse", clientX: 130, clientY: 20 }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(group.hasAttribute("data-fluid-visible")).toBe(false);
    await move(first, 20);
    await move(separate, 30);
    expect(group.hasAttribute("data-fluid-visible")).toBe(false);
  });

  it("leaves touch and keyboard behavior alone and clears pending work on cleanup", async () => {
    const { group, first } = fixture();
    await move(first, 20, "touch");
    expect(group.hasAttribute("data-fluid-visible")).toBe(false);
    await move(first, 20);
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    expect(group.hasAttribute("data-fluid-visible")).toBe(false);
    expect(document.activeElement).toBe(first);
    group.dispatchEvent(
      new PointerEvent("pointermove", { pointerType: "mouse", clientX: 20, clientY: 20 }),
    );
    dispose?.();
    dispose = undefined;
    await vi.advanceTimersByTimeAsync(20);
    expect(group.hasAttribute("data-fluid-ready")).toBe(false);
    expect(group.hasAttribute("data-fluid-visible")).toBe(false);
  });
});
