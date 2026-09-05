import { describe, expect, it } from "vitest";
import {
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

  it("keeps routine publication quiet", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "publishing",
        completedAgents: [],
        scanningAgents: [],
        totalAgents: 0,
        agentStatuses: {},
      } as unknown as ScanStatusEvent),
    ).toBeNull();
  });

  it("keeps legacy indexing quiet", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "indexing",
        completedAgents: [],
        scanningAgents: [],
        totalAgents: 0,
        agentStatuses: {},
      } as unknown as ScanStatusEvent),
    ).toBeNull();
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

  it("shows a partial refresh as completed rather than failed", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
        agentStatuses: {
          codex: {
            agentName: "codex",
            status: "complete",
            completeness: "partial",
            sourceFailureCount: 1,
            sourceFailureSummary: "SyntaxError: truncated JSON",
            updatedAt: 1,
          },
        },
      } as unknown as ScanStatusEvent),
    ).toBe(
      "Session refresh completed with partial data · codex · 1 source failed · SyntaxError: truncated JSON",
    );
  });

  it("does not warn when a completed refresh is partial only because it is windowed", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
        agentStatuses: {
          claudecode: {
            agentName: "claudecode",
            status: "complete",
            completeness: "partial",
            updatedAt: 1,
          },
        },
      } as unknown as ScanStatusEvent),
    ).toBeNull();
  });

  it("shows a completed partial full-history refresh", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: {
          active: false,
          pendingAgents: [],
          completedAgents: ["codex"],
          failedAgents: [],
          partialAgents: {
            codex: {
              completeness: "partial",
              sourceFailureCount: 2,
              sourceFailureSummary: "SyntaxError: truncated JSON",
            },
          },
        },
        agentStatuses: {},
      } as unknown as ScanStatusEvent),
    ).toBe(
      "Full-history refresh completed with partial data · codex · 2 sources failed · SyntaxError: truncated JSON",
    );
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

  it.each(["scanning", "finalizing", "publish-queued", "publishing", "indexing"] as const)(
    "keeps routine %s progress quiet",
    (phase) => {
      expect(
        formatScanStatusLabel({
          active: true,
          phase: phase === "scanning" ? "scanning" : "publishing",
          completedAgents: [],
          scanningAgents: ["codex"],
          totalAgents: 1,
          agentStatuses: {
            codex: { agentName: "codex", status: phase, total: 1, processed: 0, updatedAt: 1 },
          },
        } as unknown as ScanStatusEvent),
      ).toBeNull();
    },
  );

  it("keeps initialization visible", () => {
    expect(formatScanStatusLabel({ active: true, phase: "initializing" } as ScanStatusEvent)).toBe(
      "Initializing recent sessions",
    );
  });

  it("does not hide failures while another agent refreshes", () => {
    expect(
      formatScanStatusLabel({
        active: true,
        phase: "scanning",
        agentStatuses: { codex: { agentName: "codex", status: "failed", error: "read failed" } },
      } as unknown as ScanStatusEvent),
    ).toBe("Session refresh failed · codex · read failed");
  });

  it("does not reuse full-history scan counts while preparing publication", () => {
    expect(
      formatScanStatusLabel({
        active: false,
        backfill: {
          active: true,
          currentAgent: "zcode",
          pendingAgents: [],
          progress: { phase: "publishing", total: 84, processed: 84, sessions: 84 },
          completedAgents: [],
          failedAgents: [],
        },
      } as unknown as ScanStatusEvent),
    ).toBe("Preparing full-history publication · zcode");
  });

  it("distinguishes writing and committing a full-history index", () => {
    const status = {
      active: false,
      backfill: {
        active: true,
        currentAgent: "codex",
        pendingAgents: [],
        progress: { phase: "indexing", total: 119, processed: 119 },
        completedAgents: [],
        failedAgents: [],
      },
    } as unknown as ScanStatusEvent;

    expect(formatScanStatusLabel(status)).toBe("Writing full-history search index · codex");
    status.backfill.progress = { phase: "committing", total: 119, processed: 119 };
    expect(formatScanStatusLabel(status)).toBe("Committing full-history publication · codex");
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
    ).toBe("Full-history publication queued · zcode");
  });

  it("keeps routine search maintenance quiet", () => {
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
    ).toBeNull();
  });
});
