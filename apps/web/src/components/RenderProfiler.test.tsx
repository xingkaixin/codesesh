import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("RenderProfiler", () => {
  it("reads its disabled production flag once per module load", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
    vi.resetModules();
    const { isRenderProfilerEnabled } = await import("./RenderProfiler");
    const readsAfterLoad = getItem.mock.calls.length;
    const profilerReads = () =>
      getItem.mock.calls.filter(([key]) => key === "codeseshProfiler").length;

    expect(isRenderProfilerEnabled()).toBe(false);
    expect(isRenderProfilerEnabled()).toBe(false);
    expect(getItem).toHaveBeenCalledTimes(readsAfterLoad);
    expect(profilerReads()).toBe(1);
  });
});
