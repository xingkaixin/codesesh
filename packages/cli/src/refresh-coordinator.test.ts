import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshCoordinator } from "./refresh-coordinator.js";

afterEach(() => vi.useRealTimers());

describe("RefreshCoordinator", () => {
  it("keeps the earliest refresh deadline", async () => {
    vi.useFakeTimers();
    const coordinator = new RefreshCoordinator();
    const refresh = vi.fn(async () => undefined);

    coordinator.schedule("codex", 1_000, refresh);
    coordinator.schedule("codex", 2_000, refresh);
    coordinator.schedule("codex", 500, refresh);
    await vi.advanceTimersByTimeAsync(499);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces refresh requests received while one is running", async () => {
    vi.useFakeTimers();
    const coordinator = new RefreshCoordinator();
    let finishFirst: (() => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<"committed">((resolve) => {
          finishFirst = () => resolve("committed");
        }),
    );

    const first = coordinator.runRefresh("codex", operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    await coordinator.runRefresh("codex", operation);
    finishFirst?.();
    await first;
    await vi.advanceTimersByTimeAsync(100);

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("serializes refresh and backfill work per agent", async () => {
    const coordinator = new RefreshCoordinator();
    const order: string[] = [];
    const first = coordinator.serialize("codex", "backfill", async () => {
      order.push("backfill");
      return "committed";
    });
    const second = coordinator.serialize("codex", "refresh", async () => {
      order.push("refresh");
      return "committed";
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["backfill", "refresh"]);
  });
});
