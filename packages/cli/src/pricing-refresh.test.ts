import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), publish: vi.fn() }));
vi.mock("@codesesh/core/runtime/pricing", () => ({
  refreshPricingCache: mocks.refresh,
  publishPendingPricing: mocks.publish,
}));
vi.mock("./logging.js", () => ({ appLogger: { info: vi.fn(), warn: vi.fn() } }));
const { startPricingRefresh } = await import("./pricing-refresh.js");

beforeEach(() => vi.resetAllMocks());

describe("startup pricing", () => {
  it("waits for prices before publishing the generation used by the first scan", async () => {
    let finish!: (value: boolean) => void;
    mocks.refresh.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = startPricingRefresh();
    const ready = refresh.ready();
    expect(mocks.publish).not.toHaveBeenCalled();
    finish(true);
    await ready;
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      timeoutMs: 10_000,
    });
  });

  it("allows scanning with fallback prices when the refresh fails", async () => {
    mocks.refresh.mockRejectedValue(new Error("offline"));
    await expect(startPricingRefresh().ready()).resolves.toBeUndefined();
  });
});
