import { afterEach, describe, expect, it, vi } from "vitest";
import { addCalendarDays, startOfCalendarDay } from "@codesesh/core/contract";
import { resolveTimeWindow } from "./time-window-resolution.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-17T08:00:00.000Z").getTime();

describe("resolveTimeWindow", () => {
  it("gives an explicit CLI from value priority over days", () => {
    const from = "2026-07-01T00:00:00.000Z";

    expect(resolveTimeWindow({ mode: "cli", from, days: "7", now: NOW })).toEqual({
      from: new Date(from).getTime(),
      to: undefined,
    });
  });

  it("resolves positive CLI days as a rolling window", () => {
    expect(resolveTimeWindow({ mode: "cli", days: "7", now: NOW })).toEqual({
      from: NOW - 7 * DAY_MS,
      to: undefined,
      days: 7,
    });
  });

  it("preserves CLI all-time and date validation semantics", () => {
    expect(resolveTimeWindow({ mode: "cli", days: "0", now: NOW })).toEqual({
      to: undefined,
      days: 0,
    });
    expect(() => resolveTimeWindow({ mode: "cli", from: "not-a-date" })).toThrow(
      "Invalid date: not-a-date",
    );
  });

  // `days` counts the calendar days the window covers, matching one bucket per day.
  it("derives dashboard days from an explicit query window", () => {
    const from = new Date("2026-07-10T00:00:00.000Z").getTime();
    const to = new Date("2026-07-13T00:00:00.000Z").getTime();

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        query: {
          from: "2026-07-10T00:00:00.000Z",
          to: "2026-07-13T00:00:00.000Z",
        },
      }),
    ).toEqual({ from, to, days: 4 });
  });

  it("keeps the CLI default from value ahead of dashboard query days", () => {
    const defaultFrom = NOW - 7 * DAY_MS;

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        query: { days: "3" },
        defaults: { from: defaultFrom, days: 7 },
        now: NOW,
      }),
    ).toEqual({ from: defaultFrom, to: NOW, days: 3 });
  });

  it("supports explicit all-time dashboard windows", () => {
    expect(
      resolveTimeWindow({
        mode: "dashboard",
        query: { days: "0" },
        defaults: { from: NOW - 7 * DAY_MS, days: 7 },
        now: NOW,
      }),
    ).toEqual({ to: NOW, days: 0 });
  });

  it("uses the 30-day dashboard fallback from the local day boundary", () => {
    expect(resolveTimeWindow({ mode: "dashboard", query: {}, now: NOW })).toEqual({
      from: addCalendarDays(startOfCalendarDay(NOW), -29),
      to: NOW,
      days: 30,
    });
  });

  it("falls back from invalid dashboard query dates", () => {
    const defaultFrom = NOW - 5 * DAY_MS;

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        query: { from: "invalid", to: "invalid" },
        defaults: { from: defaultFrom, to: NOW, days: 5 },
      }),
    ).toEqual({ from: defaultFrom, to: NOW, days: 5 });
  });
});

describe("CS-133: dashboard windows are calendar ranges", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The web preset builds the same window from calendar fields; both must land
  // on the same local midnight even when a DST transition sits inside the range.
  it.each([
    { name: "spring forward", now: [2026, 2, 10, 8], days: 7 },
    { name: "fall back", now: [2026, 10, 3, 8], days: 7 },
    { name: "no transition", now: [2026, 5, 10, 8], days: 30 },
  ])("matches the web preset boundary for $name", ({ now, days }) => {
    vi.stubEnv("TZ", "America/New_York");
    const nowMs = new Date(now[0]!, now[1]!, now[2]!, now[3]!).getTime();
    const webPresetFrom = new Date(now[0]!, now[1]!, now[2]! - days + 1).getTime();

    const resolved = resolveTimeWindow({
      mode: "dashboard",
      query: { days: String(days) },
      now: nowMs,
    });

    expect(resolved.from).toBe(webPresetFrom);
    expect(new Date(resolved.from!).getHours()).toBe(0);
  });

  it("reports elapsed days as calendar days across a transition", () => {
    vi.stubEnv("TZ", "America/New_York");
    const from = new Date(2026, 2, 7).getTime();
    const to = new Date(2026, 2, 9, 23, 59).getTime();

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        query: { from: new Date(from).toISOString() },
        now: to,
      }).days,
    ).toBe(3);
  });
});
