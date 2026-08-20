import type {
  AggregateSessionSourceCapability,
  EnumeratedSessionSourceCapability,
  SessionSourceCapability,
} from "../agents/index.js";

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
