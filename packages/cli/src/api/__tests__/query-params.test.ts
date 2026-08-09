import { describe, expect, it } from "vitest";
import { parseSessionQuery, SEARCH_LIMIT_POLICY } from "../query-params.js";

describe("session query contract", () => {
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
