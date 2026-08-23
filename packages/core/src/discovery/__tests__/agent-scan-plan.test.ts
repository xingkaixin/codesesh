import { describe, expect, it, vi } from "vitest";
import {
  commitAgentRefreshCheck,
  executeAgentScanPlan,
  inspectAgentRefresh,
  planAgentScan,
  resolveSessionSnapshotCompleteness,
  selectAgentRefresh,
  type AgentScanIntent,
} from "../agent-scan-plan.js";
import type {
  AggregateSessionSourceCapability,
  BaseAgent,
  ChangeCheckResult,
  EnumeratedSessionSourceCapability,
} from "../../agents/index.js";
import type { SessionHead } from "../../types/index.js";

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

function session(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "test", sessionId: id },
    title: id,
    directory: "/tmp",
    time_created: 1,
    ...overrides,
  } as SessionHead;
}

function agent(
  source: AggregateSessionSourceCapability | EnumeratedSessionSourceCapability,
  sessions: SessionHead[] = [],
): BaseAgent {
  return {
    sessionSourceAccess: source,
    isAvailable: () => true,
    scan: vi.fn(() => sessions),
  } as unknown as BaseAgent;
}

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

describe("selectAgentRefresh", () => {
  it("stops before change detection when the agent is unavailable", async () => {
    const checkForChanges = vi.fn(aggregate.checkForChanges);
    const target = agent({ ...aggregate, checkForChanges });
    target.isAvailable = () => false;

    const selection = await selectAgentRefresh(target, {
      initialized: true,
      sinceTimestamp: 10,
      cachedSessions: [],
    });

    expect(selection).toMatchObject({ kind: "unavailable" });
    expect(checkForChanges).not.toHaveBeenCalled();
  });

  it("selects initialization before change detection", async () => {
    const checkForChanges = vi.fn(aggregate.checkForChanges);
    const target = agent({ ...aggregate, checkForChanges });

    const selection = await selectAgentRefresh(target, {
      initialized: false,
      sinceTimestamp: 10,
      cachedSessions: [],
    });

    expect(selection).toMatchObject({ kind: "initialize" });
    expect(checkForChanges).not.toHaveBeenCalled();
  });

  it("inspects an available initialized agent", async () => {
    const target = agent(aggregate);

    await expect(
      selectAgentRefresh(target, {
        initialized: true,
        sinceTimestamp: 10,
        cachedSessions: [],
      }),
    ).resolves.toMatchObject({
      kind: "recompute-derived",
      availabilityDurationMs: expect.any(Number),
    });
  });

  it.each([
    { changedIds: undefined, expectedKind: "full-scan" },
    { changedIds: [], expectedKind: "incremental-scan" },
    { changedIds: ["changed"], expectedKind: "incremental-scan" },
  ])(
    "selects $expectedKind when changed ids are $changedIds",
    async ({ changedIds, expectedKind }) => {
      const source: AggregateSessionSourceCapability = {
        ...aggregate,
        checkForChanges: () => ({ hasChanges: true, changedIds, timestamp: 11 }),
      };

      await expect(
        selectAgentRefresh(agent(source), {
          initialized: true,
          sinceTimestamp: 10,
          cachedSessions: [],
        }),
      ).resolves.toMatchObject({ kind: expectedKind });
    },
  );

  it("commits a successful aggregate refresh through the policy owner", async () => {
    const commitChangeCheck = vi.fn();
    const source: AggregateSessionSourceCapability = {
      ...aggregate,
      commitChangeCheck,
      checkForChanges: () => ({ hasChanges: false, timestamp: 11 }),
    };
    const selection = await selectAgentRefresh(agent(source), {
      initialized: true,
      sinceTimestamp: 10,
      cachedSessions: [],
    });
    if (selection.kind !== "recompute-derived") throw new Error("Expected derived refresh");

    commitAgentRefreshCheck(selection);

    expect(commitChangeCheck).toHaveBeenCalledOnce();
  });
});

describe("inspectAgentRefresh", () => {
  it("returns enumerated sources without running an aggregate change check", async () => {
    await expect(inspectAgentRefresh(enumerated, 10, [])).resolves.toEqual({
      kind: "synchronize",
      source: enumerated,
    });
  });

  it.each<{ result: ChangeCheckResult; expectedKind: "unchanged" | "scan" }>([
    {
      result: { hasChanges: false, timestamp: 11 },
      expectedKind: "unchanged",
    },
    {
      result: { hasChanges: true, changedIds: ["changed"], timestamp: 11 },
      expectedKind: "scan",
    },
  ])("classifies a successful check as $expectedKind", async ({ result, expectedKind }) => {
    const source: AggregateSessionSourceCapability = {
      ...aggregate,
      checkForChanges: () => result,
    };

    const inspection = await inspectAgentRefresh(source, 10, []);

    expect(inspection).toMatchObject({ kind: expectedKind, source, check: result });
  });

  it("preserves a failed change check as a distinct recovery class", async () => {
    const failure = {
      sourcePath: "/sessions.db",
      errorClass: "SqliteError",
      message: "database is locked",
    };
    const source: AggregateSessionSourceCapability = {
      ...aggregate,
      checkForChanges: () => ({
        status: "failed",
        hasChanges: false,
        timestamp: 10,
        failure,
      }),
    };

    const inspection = await inspectAgentRefresh(source, 10, []);

    expect(inspection).toMatchObject({ kind: "failed", failure });
  });
});

describe("executeAgentScanPlan", () => {
  it("preserves baseline tags when an aggregate reload omits derived fields", () => {
    const cached = session("same", {
      smart_tags: ["refactoring"],
      smart_tags_source_updated_at: 1,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
    const scanned = session("same", { title: "updated" });
    const target = agent(aggregate, [scanned]);

    const result = executeAgentScanPlan(
      target,
      planAgentScan(aggregate, "reload"),
      { sessions: [cached], meta: {} },
      {},
    );

    expect(target.scan).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      sessions: [
        expect.objectContaining({
          title: "updated",
          smart_tags: ["refactoring"],
          smart_tags_source_updated_at: 1,
          smart_tags_classifier_revision: "smart-tags-v1",
        }),
      ],
      changedSessionIds: [],
      sourceFailures: [],
      completeness: "complete",
    });
  });

  it("normalizes an enumerated synchronization result", () => {
    const updated = session("updated");
    const timing = {
      totalMs: 8,
      enumerationMs: 1,
      diffMs: 2,
      parseMs: 5,
      enumeratedSourceCount: 2,
      changedSourceCount: 1,
      processedSourceCount: 1,
    };
    const failure = {
      sessionId: "failed",
      sourcePath: "/tmp/failed",
      stage: "parsing" as const,
      errorClass: "SyntaxError",
      message: "invalid session",
    };
    const source: EnumeratedSessionSourceCapability = {
      kind: "enumerated",
      count: () => 2,
      synchronize: () => ({
        sessions: [updated],
        meta: {},
        sources: [],
        sourceOutcomes: [],
        detectedSessionIds: ["updated"],
        changedSessionIds: ["updated"],
        explicitRemovedSessionIds: ["removed"],
        finalizeSessionIds: ["updated"],
        sourceFailures: [failure],
        completeness: "partial",
        sourceCount: 2,
        removedSourceCount: 1,
        timing,
      }),
    };

    const result = executeAgentScanPlan(agent(source), planAgentScan(source, "reload"), {
      sessions: [],
      meta: {},
    });

    expect(result).toEqual({
      sessions: [updated],
      detectedSessionIds: ["updated"],
      changedSessionIds: ["updated"],
      finalizeSessionIds: ["updated"],
      explicitRemovedSessionIds: ["removed"],
      sourceFailures: [failure],
      completeness: "partial",
      sourceSynchronization: { sourceCount: 2, removedSourceCount: 1, timing },
    });
  });
});

describe("resolveSessionSnapshotCompleteness", () => {
  it("requires a full window without source failures", () => {
    expect(resolveSessionSnapshotCompleteness({}, [])).toBe("complete");
    expect(resolveSessionSnapshotCompleteness({ from: 1 }, [])).toBe("partial");
    expect(
      resolveSessionSnapshotCompleteness({}, [
        {
          sessionId: "failed",
          sourcePath: "/tmp/failed",
          stage: "parsing",
          errorClass: "SyntaxError",
          message: "invalid session",
        },
      ]),
    ).toBe("partial");
  });
});
