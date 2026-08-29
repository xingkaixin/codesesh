import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLoggerBeforeTermination } from "./cli-exit.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CLI log close watchdog", () => {
  it("forces the requested exit code when logger close exceeds the deadline", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    const closing = closeLoggerBeforeTermination(() => new Promise<void>(() => undefined), 7);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(
      "[codesesh] Timed out closing application log; forcing exit\n",
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("does not force exit after logger close completes", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await closeLoggerBeforeTermination(async () => undefined, 0);
    await vi.runAllTimersAsync();

    expect(stderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
