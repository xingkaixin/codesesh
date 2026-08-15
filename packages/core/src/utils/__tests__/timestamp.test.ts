import { afterEach, describe, expect, it } from "vitest";
import { parseAgentTimestamp } from "../timestamp.js";
import { setCoreDiagnostics } from "../diagnostics.js";

afterEach(() => {
  setCoreDiagnostics(null);
});

describe("parseAgentTimestamp", () => {
  it("passes finite epoch numbers through", () => {
    expect(parseAgentTimestamp(1_738_000_000_000, "test")).toBe(1_738_000_000_000);
  });

  it("parses ISO strings and normalizes space separators to UTC", () => {
    expect(parseAgentTimestamp("2026-04-20T10:00:00Z", "test")).toBe(
      Date.parse("2026-04-20T10:00:00Z"),
    );
    expect(parseAgentTimestamp("2026-04-20 10:00:00", "test")).toBe(
      Date.parse("2026-04-20T10:00:00Z"),
    );
  });

  it("accepts numeric strings only when the agent's wire format uses them", () => {
    expect(parseAgentTimestamp("1738000000000", "test", { numericStrings: true })).toBe(
      1_738_000_000_000,
    );
    // Without the option a bare number string is not a date.
    expect(parseAgentTimestamp("1738000000000", "test")).toBeNull();
  });

  it("returns null quietly for missing values and blank strings", () => {
    const events: string[] = [];
    setCoreDiagnostics({ warn: (event) => events.push(event) });

    expect(parseAgentTimestamp(null, "test")).toBeNull();
    expect(parseAgentTimestamp(undefined, "test")).toBeNull();
    expect(parseAgentTimestamp("   ", "test")).toBeNull();
    expect(events).toEqual([]);
  });

  it("reports present-but-unparseable values and returns null", () => {
    const events: string[] = [];
    setCoreDiagnostics({ warn: (event) => events.push(event) });

    expect(parseAgentTimestamp("not-a-date", "test")).toBeNull();
    expect(parseAgentTimestamp(Number.NaN, "test")).toBeNull();
    expect(parseAgentTimestamp({ nested: true }, "test")).toBeNull();
    expect(events).toEqual([
      "agent.timestamp_parse_failed",
      "agent.timestamp_parse_failed",
      "agent.timestamp_parse_failed",
    ]);
  });
});
