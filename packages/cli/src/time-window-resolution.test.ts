import { describe, expect, it } from "vitest";
import { startOfLocalDay } from "@codesesh/core";
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
    ).toEqual({ from, to, days: 3 });
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
      from: startOfLocalDay(NOW) - 29 * DAY_MS,
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
