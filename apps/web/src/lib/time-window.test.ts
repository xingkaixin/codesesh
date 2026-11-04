import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTimeWindow } from "./time-window";

const now = new Date(2026, 6, 14, 12).getTime();

describe("time window URL state", () => {
  it("resolves presets to inclusive local calendar days", () => {
    const result = resolveTimeWindow(new URLSearchParams("range=14d"), { days: 7 }, now);

    expect(result.preset).toBe("14d");
    expect(result.window).toEqual({
      from: new Date(2026, 6, 1).getTime(),
      to: new Date(2026, 6, 15).getTime() - 1,
      days: 14,
    });
  });

  it.each([7, 14, 30, 90])("resolves a %i-day fallback independently of server startup", (days) => {
    const result = resolveTimeWindow(
      new URLSearchParams(),
      {
        from: new Date(2026, 5, 15 - days).getTime(),
        days,
      },
      now,
    );

    expect(result).toEqual({
      preset: `${days}d`,
      window: {
        from: new Date(2026, 6, 15 - days).getTime(),
        to: new Date(2026, 6, 15).getTime() - 1,
        days,
      },
    });
  });
});

describe("CS-133: presets are calendar ranges", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The CLI dashboard fallback builds the same window from the shared calendar
  // module; both must land on the same local midnight across a DST transition.
  it.each([
    { name: "spring forward", today: [2026, 2, 10], days: 7 },
    { name: "fall back", today: [2026, 10, 3], days: 7 },
  ])("keeps the preset start at local midnight for $name", ({ today, days }) => {
    vi.stubEnv("TZ", "America/New_York");
    const nowMs = new Date(today[0]!, today[1]!, today[2]!, 12).getTime();

    const { window } = resolveTimeWindow(new URLSearchParams(`range=${days}d`), { days }, nowMs);

    expect(window.from).toBe(new Date(today[0]!, today[1]!, today[2]! - days + 1).getTime());
    expect(new Date(window.from!).getHours()).toBe(0);
    expect(window.to).toBe(new Date(today[0]!, today[1]!, today[2]! + 1).getTime() - 1);
  });
});
