import { describe, expect, it } from "vitest";
import { planAgentScan, type AgentScanIntent } from "../agent-scan-plan.js";
import type {
  AggregateSessionSourceCapability,
  EnumeratedSessionSourceCapability,
} from "../../agents/index.js";

const enumerated: EnumeratedSessionSourceCapability = {
  kind: "enumerated",
  synchronize: () => ({}) as never,
  count: () => 0,
};

const aggregate: AggregateSessionSourceCapability = {
  kind: "aggregate",
  checkForChanges: () => ({ hasChanges: false, timestamp: 0 }),
  commitChangeCheck: () => undefined,
  incrementalScan: (sessions) => sessions,
};

describe("planAgentScan", () => {
  it.each<{
    sourceKind: "enumerated" | "aggregate";
    intent: AgentScanIntent;
    expected: { kind: string; requestKind?: "reload" | "refresh" };
  }>([
    {
      sourceKind: "enumerated",
      intent: "reload",
      expected: { kind: "synchronize", requestKind: "reload" },
    },
    {
      sourceKind: "enumerated",
      intent: "refresh",
      expected: { kind: "synchronize", requestKind: "refresh" },
    },
    {
      sourceKind: "enumerated",
      intent: "backfill",
      expected: { kind: "synchronize", requestKind: "refresh" },
    },
    {
      sourceKind: "aggregate",
      intent: "reload",
      expected: { kind: "scan" },
    },
    {
      sourceKind: "aggregate",
      intent: "refresh",
      expected: { kind: "check-for-changes" },
    },
    {
      sourceKind: "aggregate",
      intent: "backfill",
      expected: { kind: "scan" },
    },
    {
      sourceKind: "enumerated",
      intent: "recompute-derived",
      expected: { kind: "reuse-baseline" },
    },
    {
      sourceKind: "aggregate",
      intent: "recompute-derived",
      expected: { kind: "reuse-baseline" },
    },
  ])("plans $sourceKind $intent as $expected.kind", ({ sourceKind, intent, expected }) => {
    const source = sourceKind === "enumerated" ? enumerated : aggregate;
    const plan = planAgentScan(source, intent);
    expect({
      kind: plan.kind,
      ...(plan.kind === "synchronize" ? { requestKind: plan.requestKind } : {}),
    }).toEqual(expected);
    if (plan.kind === "synchronize" || plan.kind === "check-for-changes") {
      expect(plan.source).toBe(source);
    }
  });
});
