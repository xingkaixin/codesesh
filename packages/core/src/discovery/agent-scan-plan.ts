import type {
  AggregateSessionSourceCapability,
  AgentScanOptions,
  BaseAgent,
  ChangeCheckResult,
  EnumeratedSessionSourceCapability,
  SessionSourceFailure,
  SessionSourceCapability,
  SessionSourceSynchronizationBaseline,
  SessionSourceSynchronizationTiming,
} from "../agents/index.js";
import type { SessionHead } from "../types/index.js";
import type { SessionSnapshotCompleteness } from "./cache/snapshot-types.js";
import { inheritSessionTags } from "./session-tags.js";

export type AgentScanIntent = "reload" | "refresh" | "backfill" | "recompute-derived";

export type AgentScanPlan =
  | { kind: "scan" }
  | {
      kind: "synchronize";
      requestKind: "reload" | "refresh";
      source: EnumeratedSessionSourceCapability;
    }
  | { kind: "check-for-changes"; source: AggregateSessionSourceCapability }
  | { kind: "reuse-baseline" };

type SourceScanPlan = Extract<AgentScanPlan, { kind: "scan" | "synchronize" }>;
type RefreshScanPlan = Extract<AgentScanPlan, { kind: "synchronize" | "check-for-changes" }>;
type RecomputeScanPlan = Extract<AgentScanPlan, { kind: "reuse-baseline" }>;
export type ExecutableAgentScanPlan = Exclude<AgentScanPlan, { kind: "check-for-changes" }>;

export interface AgentScanPlanExecution {
  sessions: SessionHead[];
  detectedSessionIds: string[];
  changedSessionIds: string[];
  finalizeSessionIds?: string[];
  explicitRemovedSessionIds: string[];
  sourceFailures: SessionSourceFailure[];
  completeness: SessionSnapshotCompleteness;
  sourceSynchronization?: {
    sourceCount: number;
    removedSourceCount: number;
    timing: SessionSourceSynchronizationTiming;
  };
}

type SuccessfulChangeCheck = Exclude<ChangeCheckResult, { status: "failed" }>;

export function resolveSessionSnapshotCompleteness(
  options: Pick<AgentScanOptions, "from" | "to">,
  sourceFailures: readonly SessionSourceFailure[],
): SessionSnapshotCompleteness {
  return options.from == null && options.to == null && sourceFailures.length === 0
    ? "complete"
    : "partial";
}

export function executeAgentScanPlan(
  agent: BaseAgent,
  plan: ExecutableAgentScanPlan,
  baseline: SessionSourceSynchronizationBaseline,
  scanOptions: AgentScanOptions = {},
): AgentScanPlanExecution {
  if (plan.kind === "synchronize") {
    const result = plan.source.synchronize(baseline, {
      kind: plan.requestKind,
      scanOptions,
    });
    return {
      sessions: result.sessions,
      detectedSessionIds: result.detectedSessionIds,
      changedSessionIds: result.changedSessionIds,
      finalizeSessionIds: result.finalizeSessionIds,
      explicitRemovedSessionIds: result.explicitRemovedSessionIds,
      sourceFailures: result.sourceFailures,
      completeness: result.completeness,
      sourceSynchronization: {
        sourceCount: result.sourceCount,
        removedSourceCount: result.removedSourceCount,
        timing: result.timing,
      },
    };
  }

  const sessions =
    plan.kind === "reuse-baseline"
      ? baseline.sessions
      : inheritSessionTags(agent.scan(scanOptions), baseline.sessions);
  const sourceFailures: SessionSourceFailure[] = [];
  return {
    sessions,
    detectedSessionIds: [],
    changedSessionIds: [],
    explicitRemovedSessionIds: [],
    sourceFailures,
    completeness: resolveSessionSnapshotCompleteness(scanOptions, sourceFailures),
  };
}

export type AgentRefreshInspection =
  | {
      kind: "synchronize";
      source: EnumeratedSessionSourceCapability;
    }
  | {
      kind: "failed";
      failure: Extract<ChangeCheckResult, { status: "failed" }>["failure"];
      checkDurationMs: number;
    }
  | {
      kind: "unchanged";
      source: AggregateSessionSourceCapability;
      check: SuccessfulChangeCheck;
      checkDurationMs: number;
    }
  | {
      kind: "scan";
      source: AggregateSessionSourceCapability;
      check: SuccessfulChangeCheck;
      checkDurationMs: number;
    };

export function planAgentScan(
  source: SessionSourceCapability,
  intent: "reload" | "backfill",
): SourceScanPlan;
export function planAgentScan(source: SessionSourceCapability, intent: "refresh"): RefreshScanPlan;
export function planAgentScan(
  source: SessionSourceCapability,
  intent: "recompute-derived",
): RecomputeScanPlan;
export function planAgentScan(
  source: SessionSourceCapability,
  intent: AgentScanIntent,
): AgentScanPlan;
export function planAgentScan(
  source: SessionSourceCapability,
  intent: AgentScanIntent,
): AgentScanPlan {
  if (intent === "recompute-derived") return { kind: "reuse-baseline" };

  if (source.kind === "enumerated") {
    return {
      kind: "synchronize",
      requestKind: intent === "reload" ? "reload" : "refresh",
      source,
    };
  }

  return intent === "refresh" ? { kind: "check-for-changes", source } : { kind: "scan" };
}

export async function inspectAgentRefresh(
  source: SessionSourceCapability,
  sinceTimestamp: number,
  cachedSessions: SessionHead[],
): Promise<AgentRefreshInspection> {
  const plan = planAgentScan(source, "refresh");
  if (plan.kind === "synchronize") {
    return { kind: "synchronize", source: plan.source };
  }

  const startedAt = performance.now();
  const check = await Promise.resolve(plan.source.checkForChanges(sinceTimestamp, cachedSessions));
  const checkDurationMs = performance.now() - startedAt;
  if (check.status === "failed") {
    return { kind: "failed", failure: check.failure, checkDurationMs };
  }
  return check.hasChanges
    ? { kind: "scan", source: plan.source, check, checkDurationMs }
    : { kind: "unchanged", source: plan.source, check, checkDurationMs };
}
