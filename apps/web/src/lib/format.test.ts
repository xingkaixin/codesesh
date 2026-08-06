import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatCompact,
  formatCostSource,
  formatDelta,
  formatInt,
  formatMessageTime,
  formatMonthDay,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelativeCn,
  formatRelativeTime,
  formatTokens,
  formatUsd,
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

describe("formatInt", () => {
  it("formats with thousands separators", () => {
    expect(formatInt(24918)).toBe("24,918");
    expect(formatInt(0)).toBe("0");
  });

  it("rounds fractions away", () => {
    expect(formatInt(1234.6)).toBe("1,235");
  });
});

describe("formatCompact", () => {
  it("formats millions with one decimal", () => {
    expect(formatCompact(128_400_000)).toBe("128.4M");
    expect(formatCompact(1_000_000)).toBe("1.0M");
  });

  it("formats thousands with one decimal", () => {
    expect(formatCompact(58_200)).toBe("58.2k");
    expect(formatCompact(1_000)).toBe("1.0k");
    expect(formatCompact(999_999)).toBe("1000.0k");
  });

  it("falls back to formatInt below one thousand", () => {
    expect(formatCompact(942)).toBe("942");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(0)).toBe("0");
  });
});

describe("formatUsd", () => {
  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats with two decimals and thousands separators", () => {
    expect(formatUsd(412.855)).toBe("$412.86");
    expect(formatUsd(12345.6)).toBe("$12,345.60");
  });

  it("rounds sub-cent values to two decimals", () => {
    expect(formatUsd(0.004)).toBe("$0.00");
  });
});

describe("formatDelta", () => {
  it("returns null for a non-positive base", () => {
    expect(formatDelta(10, 0)).toBeNull();
    expect(formatDelta(10, -5)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(formatDelta(Number.NaN, 10)).toBeNull();
    expect(formatDelta(10, Number.NaN)).toBeNull();
    expect(formatDelta(10, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("marks growth with an up arrow", () => {
    expect(formatDelta(112, 100)).toBe("▲ 12%");
    expect(formatDelta(100, 100)).toBe("▲ 0%");
  });

  it("marks decline with a down arrow", () => {
    expect(formatDelta(95, 100)).toBe("▼ 5%");
  });

  it("rounds the percentage to an integer", () => {
    expect(formatDelta(101.4, 100)).toBe("▲ 1%");
  });
});

describe("formatRelativeCn", () => {
  const now = new Date(2025, 7, 3, 9, 12).getTime();

  it("returns 刚刚 under a minute and for future timestamps", () => {
    expect(formatRelativeCn(now - 30_000, now)).toBe("刚刚");
    expect(formatRelativeCn(now + 10_000, now)).toBe("刚刚");
  });

  it("returns minutes under an hour", () => {
    expect(formatRelativeCn(now - 12 * 60_000, now)).toBe("12 分");
    expect(formatRelativeCn(now - 59 * 60_000, now)).toBe("59 分");
  });

  it("returns hours under a day", () => {
    expect(formatRelativeCn(now - 3 * 3600_000, now)).toBe("3 小时");
    expect(formatRelativeCn(now - 23 * 3600_000, now)).toBe("23 小时");
  });

  it("returns 昨天 for the previous calendar day", () => {
    expect(formatRelativeCn(new Date(2025, 7, 2, 4, 0).getTime(), now)).toBe("昨天");
  });

  it("returns a month-day label further back", () => {
    expect(formatRelativeCn(new Date(2025, 6, 28, 4, 0).getTime(), now)).toBe("7月28日");
  });
});

describe("formatMonthDay", () => {
  it("reads the day out of an ISO date string without shifting time zones", () => {
    expect(formatMonthDay("2025-08-03")).toBe("08-03");
    expect(formatMonthDay("2025-08-03T23:30:00Z")).toBe("08-03");
  });

  it("formats a timestamp in local time", () => {
    expect(formatMonthDay(new Date(2025, 7, 3, 9, 12).getTime())).toBe("08-03");
  });

  it("returns an empty string for an unparsable date", () => {
    expect(formatMonthDay("not-a-date")).toBe("");
  });
});

describe("formatClockTime", () => {
  it("formats a 24-hour clock time", () => {
    expect(formatClockTime(new Date(2025, 7, 3, 9, 12).getTime())).toBe("09:12");
    expect(formatClockTime(new Date(2025, 7, 3, 23, 5).getTime())).toBe("23:05");
    expect(formatClockTime(new Date(2025, 7, 3, 0, 0).getTime())).toBe("00:00");
  });

  it("returns an empty string for a non-finite timestamp", () => {
    expect(formatClockTime(Number.NaN)).toBe("");
  });
});

describe("formatPercent", () => {
  it("formats a 0..1 ratio as a rounded percentage", () => {
    expect(formatPercent(0.41)).toBe("41%");
    expect(formatPercent(0.415)).toBe("42%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("reports 0% for a zero-denominator ratio", () => {
    expect(formatPercent(Number.NaN)).toBe("0%");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0%");
  });
});

describe("formatMessageTime", () => {
  it("formats a millisecond timestamp", () => {
    const result = formatMessageTime(Date.now());
    expect(result).toBeTypeOf("string");
    if (result === null) throw new Error("expected a formatted message time");
    expect(result.length).toBeGreaterThan(0);
  });

  it("omits missing or invalid timestamps", () => {
    expect(formatMessageTime(0)).toBeNull();
    expect(formatMessageTime(undefined)).toBeNull();
    expect(formatMessageTime("0")).toBeNull();
    expect(formatMessageTime("not-a-time")).toBeNull();
  });
});
