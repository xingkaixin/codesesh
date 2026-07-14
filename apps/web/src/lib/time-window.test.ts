import { describe, expect, it } from "vitest";
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
    const fallback = { from: 10, to: 20, days: 7 };
    expect(
      resolveTimeWindow(
        new URLSearchParams("range=custom&from=2026-07-20&to=2026-07-05"),
        fallback,
        now,
      ).window,
    ).toBe(fallback);
  });

  it("preserves unrelated URL parameters", () => {
    const params = new URLSearchParams("view=projects&from=old&to=old");
    expect(writeTimeWindowPreset(params, "30d").toString()).toBe("view=projects&range=30d");
    expect(writeCustomTimeWindow(params, "2026-07-01", "2026-07-14").toString()).toBe(
      "view=projects&from=2026-07-01&to=2026-07-14&range=custom",
    );
  });
});
