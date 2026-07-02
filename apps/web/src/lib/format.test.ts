import { describe, expect, it } from "vitest";
import {
  formatCostSource,
  formatMessageTime,
  formatMoney,
  formatNumber,
  formatRelativeTime,
  formatTokens,
} from "./format";

describe("formatRelativeTime", () => {
  it("returns unknown for undefined", () => {
    expect(formatRelativeTime(undefined)).toBe("unknown");
  });

  it("returns unknown for null", () => {
    expect(formatRelativeTime(null)).toBe("unknown");
  });

  it("returns unknown for zero", () => {
    expect(formatRelativeTime(0)).toBe("unknown");
  });

  it("returns just now for the current instant", () => {
    expect(formatRelativeTime(Date.now())).toBe("just now");
  });

  it("returns just now for a future timestamp", () => {
    expect(formatRelativeTime(Date.now() + 10_000)).toBe("just now");
  });

  it("returns just now under one minute", () => {
    expect(formatRelativeTime(Date.now() - 30 * 1000)).toBe("just now");
  });

  it("returns minutes ago under one hour", () => {
    expect(formatRelativeTime(Date.now() - 5 * 60 * 1000)).toBe("5m ago");
    expect(formatRelativeTime(Date.now() - 59 * 60 * 1000)).toBe("59m ago");
  });

  it("returns hours ago under one day", () => {
    expect(formatRelativeTime(Date.now() - 60 * 60 * 1000)).toBe("1h ago");
    expect(formatRelativeTime(Date.now() - 90 * 60 * 1000)).toBe("1h ago");
    expect(formatRelativeTime(Date.now() - 23 * 60 * 60 * 1000)).toBe("23h ago");
  });

  it("returns days ago at and beyond 24 hours", () => {
    expect(formatRelativeTime(Date.now() - 24 * 60 * 60 * 1000)).toBe("1d ago");
    expect(formatRelativeTime(Date.now() - 3 * 24 * 60 * 60 * 1000)).toBe("3d ago");
  });
});

describe("formatNumber", () => {
  it("formats zero", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("formats with thousands separators", () => {
    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("formats negative numbers", () => {
    expect(formatNumber(-1234)).toBe("-1,234");
  });

  it("formats decimals", () => {
    expect(formatNumber(1.5)).toBe("1.5");
  });
});

describe("formatMoney", () => {
  it("formats zero as $0.00", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("formats sub-cent values with 4 decimals", () => {
    expect(formatMoney(0.001)).toBe("$0.0010");
    expect(formatMoney(0.009999)).toBe("$0.0100");
  });

  it("formats values at or above one cent with 2 decimals", () => {
    expect(formatMoney(0.01)).toBe("$0.01");
    expect(formatMoney(1.005)).toBe("$1.00");
    expect(formatMoney(1234.5)).toBe("$1234.50");
  });

  it("formats negative values", () => {
    expect(formatMoney(-1)).toBe("$-1.0000");
  });
});

describe("formatCostSource", () => {
  it("returns recorded", () => {
    expect(formatCostSource("recorded")).toBe("recorded");
  });

  it("returns estimated", () => {
    expect(formatCostSource("estimated")).toBe("estimated");
  });

  it("returns undefined for undefined", () => {
    expect(formatCostSource(undefined)).toBeUndefined();
  });
});

describe("formatTokens", () => {
  it("formats zero", () => {
    expect(formatTokens(0)).toBe("0");
  });

  it("formats values under 1000 as-is", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(999999)).toBe("1000.0K");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2500000)).toBe("2.5M");
  });

  it("formats negative values as-is", () => {
    expect(formatTokens(-500)).toBe("-500");
  });
});

describe("formatMessageTime", () => {
  it("formats a millisecond timestamp", () => {
    const result = formatMessageTime(Date.now());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
