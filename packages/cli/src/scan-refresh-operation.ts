import type { AgentScanIntent } from "@codesesh/core";

type DurableCheckpoint = { checkpoint?: "durable" };

export type ScanRefreshOperation =
  | ({ kind: "full-scan" } & DurableCheckpoint)
  | ({ kind: "source-refresh" } & DurableCheckpoint)
  | { kind: "recompute-derived" }
  | ({ kind: "backfill"; cursor?: string | null } & DurableCheckpoint);

export type BackfillScanRefreshOperation = Extract<ScanRefreshOperation, { kind: "backfill" }>;

export function isBackfillOperation(
  operation: ScanRefreshOperation,
): operation is BackfillScanRefreshOperation {
  return operation.kind === "backfill";
}

export function usesDurableCheckpoints(operation: ScanRefreshOperation): boolean {
  return "checkpoint" in operation && operation.checkpoint === "durable";
}

export function scanIntentForOperation(operation: ScanRefreshOperation): AgentScanIntent {
  switch (operation.kind) {
    case "full-scan":
      return "reload";
    case "source-refresh":
      return "refresh";
    case "recompute-derived":
      return "recompute-derived";
    case "backfill":
      return "backfill";
  }
}
