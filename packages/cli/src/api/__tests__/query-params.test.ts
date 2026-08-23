import { describe, expect, it } from "vitest";
import {
  parseDateParam,
  parseDateWindow,
  parseSessionQuery,
  SEARCH_LIMIT_POLICY,
} from "../query-params.js";

describe("session query contract", () => {
  it("distinguishes default, valid, and invalid date values", () => {
    expect(parseDateParam(undefined, 1000)).toEqual({ kind: "default", value: 1000 });
    expect(parseDateParam("   ", 1000)).toEqual({ kind: "default", value: 1000 });
    expect(parseDateParam("2026-08-12", 1000)).toEqual({
      kind: "valid",
      value: new Date("2026-08-12").getTime(),
    });
    expect(parseDateParam("not-a-date", 1000)).toEqual({
      kind: "invalid",
      error: "must be a valid date",
    });
  });

  it("identifies the first invalid date window parameter", () => {
    expect(parseDateWindow(new URLSearchParams("from=bad&to=also-bad"), {})).toEqual({
      kind: "invalid",
      parameter: "from",
      error: "must be a valid date",
    });
    expect(parseDateWindow(new URLSearchParams("to=bad"), { from: 1000 })).toEqual({
      kind: "invalid",
      parameter: "to",
      error: "must be a valid date",
    });
  });

  it("rejects a date window whose start is after its end", () => {
    expect(parseDateWindow(new URLSearchParams("from=2026-08-13&to=2026-08-12"), {})).toEqual({
      kind: "invalid",
      parameter: "from",
      error: "must not be after to",
    });
  });

  it("records whether the start came from the query", () => {
    expect(parseDateWindow(new URLSearchParams(), { from: 1000, to: 2000 })).toEqual({
      kind: "valid",
      from: 1000,
      to: 2000,
      hasExplicitFrom: false,
    });
    expect(parseDateWindow(new URLSearchParams("from=1970-01-01T00:00:01.500Z"), {})).toEqual({
      kind: "valid",
      from: 1500,
      to: undefined,
      hasExplicitFrom: true,
    });
  });

  it("distinguishes an absent agent from known and unknown values", () => {
    expect(parseSessionQuery(new URLSearchParams(), ["claudecode"]).agent).toEqual({
      kind: "all",
    });
    expect(
      parseSessionQuery(new URLSearchParams("agent=ClaudeCode"), ["claudecode"]).agent,
    ).toEqual({ kind: "known", agentName: "claudecode" });
    expect(
      parseSessionQuery(new URLSearchParams("agent=nonexistent"), ["claudecode"]).agent,
    ).toEqual({ kind: "unknown" });
    expect(parseSessionQuery(new URLSearchParams("agent="), ["claudecode"]).agent).toEqual({
      kind: "unknown",
    });
  });

  it.each([
    [undefined, { kind: "default", value: 50 }],
    ["1", { kind: "valid", value: 1 }],
    ["100", { kind: "valid", value: 100 }],
    ["999999999999999999999", { kind: "valid", value: 100 }],
  ])("parses and bounds limit %j", (value, expected) => {
    const params = new URLSearchParams();
    if (value !== undefined) params.set("limit", value);

    expect(parseSessionQuery(params, [], SEARCH_LIMIT_POLICY).limit).toEqual(expected);
  });

  it.each(["1.5", "0", "-1", "", "Infinity", "text"])("rejects invalid limit %j", (limit) => {
    expect(
      parseSessionQuery(new URLSearchParams({ limit }), [], SEARCH_LIMIT_POLICY).limit,
    ).toEqual({ kind: "invalid", error: "limit must be a positive integer" });
  });
});
