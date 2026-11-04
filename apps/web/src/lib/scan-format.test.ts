import { describe, expect, it } from "vitest";
import { formatScanStatusLabel } from "./scan-format";
import type { ScanStatusEvent } from "@codesesh/contract";

function scanStatus(overrides: Partial<ScanStatusEvent>): ScanStatusEvent {
  return {
    type: "scan-status",
    active: false,
    phase: "idle",
    pendingAgents: [],
    scanningAgents: [],
    completedAgents: [],
    agentStatuses: {},
    totalAgents: 0,
    updatedAt: 0,
    backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
    ...overrides,
  };
}

describe("formatScanStatusLabel", () => {
  it("surfaces an inactive refresh failure", () => {
    const status = scanStatus({
      active: false,
      agentStatuses: {
        codex: { updatedAt: 0, agentName: "codex", status: "failed", error: "cache is read-only" },
      },
    });

    expect(formatScanStatusLabel(status)).toBe(
      "Session refresh failed · codex · cache is read-only",
    );
  });

  it("does not hide failures while another agent refreshes", () => {
    expect(
      formatScanStatusLabel(
        scanStatus({
          active: true,
          phase: "scanning",
          agentStatuses: {
            codex: { updatedAt: 0, agentName: "codex", status: "failed", error: "read failed" },
          },
        }),
      ),
    ).toBe("Session refresh failed · codex · read failed");
  });
});
