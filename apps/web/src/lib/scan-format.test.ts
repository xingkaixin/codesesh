import { describe, expect, it } from "vitest";
import {
  formatAgentScanProgress,
  formatIsoDate,
  formatScanStatusLabel,
  formatSearchSubtitle,
  formatWindowLabel,
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
      } as unknown as ScanStatusEvent),
    ).toBe("Preparing local session index");
  });

  it("surfaces an inactive refresh failure", () => {
    const status = {
      active: false,
      backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
      agentStatuses: {
        codex: { agentName: "codex", status: "failed", error: "cache is read-only" },
      },
    } as unknown as ScanStatusEvent;

    expect(formatScanStatusLabel(status)).toBe(
      "Session refresh failed · codex · cache is read-only",
    );
    expect(formatAgentScanProgress(status, "codex")).toBe("Failed");
  });

  it("shows full-history backfill progress after the main scan finishes", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: {
          active: true,
          currentAgent: "codex",
          pendingAgents: ["claudecode"],
          completedAgents: [],
          failedAgents: [],
        },
      } as unknown as ScanStatusEvent),
    ).toBe("Indexing full history · codex · 1 queued");
  });

  it("shows backfill finalization progress", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: {
          active: true,
          currentAgent: "codex",
          pendingAgents: [],
          progress: { phase: "finalizing", total: 2107, processed: 68 },
          completedAgents: [],
          failedAgents: [],
        },
      } as unknown as ScanStatusEvent),
    ).toBe(
      "Finalizing session metadata · codex · 68/2107. Progress is saved; you can resume later.",
    );
  });

  it("shows finalization progress instead of a stalled scan label", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "indexing",
        completedAgents: ["claudecode"],
        scanningAgents: ["codex"],
        totalAgents: 2,
        agentStatuses: {
          codex: {
            agentName: "codex",
            status: "finalizing",
            total: 2108,
            processed: 17,
            updatedAt: 1,
          },
        },
      } as unknown as ScanStatusEvent),
    ).toBe(
      "Finalizing session metadata · codex · 17/2108 · 1/2 agents ready. Progress is saved; you can resume later.",
    );
  });
});

describe("formatAgentScanProgress", () => {
  it("returns null for complete or missing agent", () => {
    expect(formatAgentScanProgress(null, "codex")).toBeNull();
  });

  it("distinguishes indexing from scanning and pending", () => {
    const status = {
      agentStatuses: {
        codex: { status: "indexing" },
        claude: { status: "scanning" },
        kimi: { status: "pending" },
      },
    } as unknown as ScanStatusEvent;

    expect(formatAgentScanProgress(status, "codex")).toBe("Indexing");
    expect(formatAgentScanProgress(status, "claude")).toBe("Scanning");
    expect(formatAgentScanProgress(status, "kimi")).toBe("Pending");
  });
});
