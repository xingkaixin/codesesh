import type {
  AggregateSessionSourceCapability,
  ChangeCheckResult,
  EnumeratedSessionSourceCapability,
  SessionSourceCapability,
} from "../agents/index.js";
import type { SessionHead } from "../types/index.js";

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

type SuccessfulChangeCheck = Exclude<ChangeCheckResult, { status: "failed" }>;

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
