import { describe, expect, it } from "vitest";
import {
  formatAgentScanProgress,
  formatIsoDate,
  formatRelativeTime,
  formatScanStatusLabel,
  formatSearchSubtitle,
  formatWindowLabel,
  getAgentDisplayCount,
} from "./scan-format";
import type { ScanStatusEvent } from "./api";

describe("formatIsoDate", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(formatIsoDate(new Date("2026-06-21T14:30:00").getTime())).toBe("2026-06-21");
  });
});

describe("formatWindowLabel", () => {
  it("returns All time when from is null", () => {
    expect(formatWindowLabel({ window: { from: null, to: 1000 } } as never)).toBe("All time");
  });

  it("returns null for null config", () => {
    expect(formatWindowLabel(null)).toBeNull();
  });
});

describe("formatSearchSubtitle", () => {
  it("shows searching message while loading", () => {
    expect(formatSearchSubtitle("query", true, 0)).toContain("Searching");
  });

  it("shows count when done", () => {
    expect(formatSearchSubtitle("query", false, 5)).toContain("5 matches");
  });
});

describe("formatScanStatusLabel", () => {
  it("returns null for inactive status", () => {
    expect(formatScanStatusLabel(null)).toBeNull();
    expect(formatScanStatusLabel({ active: false } as ScanStatusEvent)).toBeNull();
  });

  it("returns indexing message for indexing phase", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "indexing",
        completedAgents: [],
        scanningAgents: [],
        totalAgents: 0,
        agentStatuses: {},
      } as ScanStatusEvent),
    ).toBe("Preparing local session index");
  });
});

describe("formatAgentScanProgress", () => {
  it("returns null for complete or missing agent", () => {
    expect(formatAgentScanProgress(null, "codex")).toBeNull();
  });
});

describe("getAgentDisplayCount", () => {
  it("returns fallback when agent status missing", () => {
    expect(getAgentDisplayCount(null, "codex", 5)).toBe(5);
  });
});

describe("formatRelativeTime", () => {
  it("returns unknown for missing timestamp", () => {
    expect(formatRelativeTime(undefined)).toBe("unknown");
  });

  it("returns just now for recent", () => {
    expect(formatRelativeTime(Date.now())).toBe("just now");
  });
});
