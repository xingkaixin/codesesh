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

  it("returns a publishing message for the publishing phase", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "publishing",
        completedAgents: [],
        scanningAgents: [],
        totalAgents: 0,
        agentStatuses: {},
      } as unknown as ScanStatusEvent),
    ).toBe("Publishing session updates");
  });

  it("maps the legacy indexing phase to publishing", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "indexing",
        completedAgents: [],
        scanningAgents: [],
        totalAgents: 0,
        agentStatuses: {},
      } as unknown as ScanStatusEvent),
    ).toBe("Publishing session updates");
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
    ).toBe("Scanning full session history · codex · 1 history scan queued");
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
    ).toBe("Finalizing full-history metadata · codex · 68/2107");
  });

  it("shows finalization progress instead of a stalled scan label", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "publishing",
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
    ).toBe("Finalizing session metadata · codex · 17/2108 · 1/2 agents ready");
  });

  it("does not claim published progress can resume", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: {
          active: true,
          currentAgent: "zcode",
          pendingAgents: [],
          progress: { phase: "publishing", sessions: 84 },
          completedAgents: [],
          failedAgents: [],
        },
      } as unknown as ScanStatusEvent),
    ).toBe("Publishing full-history sessions · zcode");
  });

  it("does not describe a queued full-history publication as active", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: {
          active: true,
          currentAgent: "zcode",
          pendingAgents: [],
          progress: { phase: "publish-queued", total: 84, processed: 84, sessions: 84 },
          completedAgents: [],
          failedAgents: [],
        },
      } as unknown as ScanStatusEvent),
    ).toBe("Full-history publication queued · zcode · 84/84");
  });

  it("labels search maintenance as non-blocking background work", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
        agentStatuses: {},
        searchIndexMaintenance: {
          active: true,
          currentAgent: "codex",
          pendingAgents: [],
          remaining: 2199,
          completedAgents: [],
          failedAgents: [],
        },
      } as unknown as ScanStatusEvent),
    ).toBe("Updating search index in background · codex · 2199 remaining");
  });
});

describe("formatAgentScanProgress", () => {
  it("returns null for complete or missing agent", () => {
    expect(formatAgentScanProgress(null, "codex")).toBeNull();
  });

  it("distinguishes publishing from scanning and pending", () => {
    const status = {
      agentStatuses: {
        codex: { status: "publishing" },
        zcode: { status: "publish-queued" },
        claude: { status: "scanning" },
        kimi: { status: "pending" },
      },
    } as unknown as ScanStatusEvent;

    expect(formatAgentScanProgress(status, "codex")).toBe("Publishing");
    expect(formatAgentScanProgress(status, "zcode")).toBe("Queued to publish");
    expect(formatAgentScanProgress(status, "claude")).toBe("Scanning");
    expect(formatAgentScanProgress(status, "kimi")).toBe("Pending");
  });
});
