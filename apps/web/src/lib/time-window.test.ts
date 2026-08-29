import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTimeWindow, writeCustomTimeWindow, writeTimeWindowPreset } from "./time-window";

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

  it("represents all time explicitly instead of falling back to server defaults", () => {
    expect(resolveTimeWindow(new URLSearchParams("range=all"), { days: 7 }, now).window).toEqual({
      from: 0,
      days: 0,
    });
  });

  it("includes the complete custom end date", () => {
    const result = resolveTimeWindow(
      new URLSearchParams("range=custom&from=2026-07-02&to=2026-07-05"),
      { days: 7 },
      now,
    );

    expect(result.window).toEqual({
      from: new Date(2026, 6, 2).getTime(),
      to: new Date(2026, 6, 6).getTime() - 1,
    });
  });

  it("falls back when a custom range is invalid", () => {
    const fallback = { from: 10, to: 20, days: 3 };
    expect(
      resolveTimeWindow(
        new URLSearchParams("range=custom&from=2026-07-20&to=2026-07-05"),
        fallback,
        now,
      ).window,
    ).toBe(fallback);
  });

  it("re-resolves a preset fallback at the current local day", () => {
    const result = resolveTimeWindow(
      new URLSearchParams(),
      {
        from: new Date(2026, 6, 8).getTime(),
        to: new Date(2026, 6, 15).getTime() - 1,
        days: 7,
      },
      now,
    );

    expect(result).toEqual({
      preset: "7d",
      window: {
        from: new Date(2026, 6, 8).getTime(),
        to: new Date(2026, 6, 15).getTime() - 1,
        days: 7,
      },
    });
  });

  it("does not treat contradictory fallback bounds as a preset", () => {
    const fallback = {
      from: new Date(2026, 6, 1).getTime(),
      to: new Date(2026, 6, 15).getTime() - 1,
      days: 7,
    };

    expect(resolveTimeWindow(new URLSearchParams(), fallback, now)).toEqual({
      preset: "custom",
      window: fallback,
      customFrom: "2026-07-01",
      customTo: "2026-07-14",
    });
  });

  it("removes the fixed upper bound from an all-time fallback", () => {
    expect(resolveTimeWindow(new URLSearchParams(), { to: 20, days: 0 }, now).window).toEqual({
      from: 0,
      days: 0,
    });
  });

  it("preserves unrelated URL parameters", () => {
    const params = new URLSearchParams("view=projects&from=old&to=old");
    expect(writeTimeWindowPreset(params, "30d").toString()).toBe("view=projects&range=30d");
    expect(writeCustomTimeWindow(params, "2026-07-01", "2026-07-14").toString()).toBe(
      "view=projects&from=2026-07-01&to=2026-07-14&range=custom",
    );
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
