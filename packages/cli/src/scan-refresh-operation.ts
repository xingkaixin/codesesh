type DurableCheckpoint = { checkpoint?: "durable" };

export type ScanRefreshOperation =
  | ({ kind: "full-scan" } & DurableCheckpoint)
  | { kind: "incremental-scan"; changedIds: string[] }
  | ({ kind: "source-refresh" } & DurableCheckpoint)
  | { kind: "recompute-derived" }
  | ({ kind: "full-backfill"; cursor?: string | null } & DurableCheckpoint)
  | ({ kind: "source-backfill"; cursor?: string | null } & DurableCheckpoint);

export type BackfillScanRefreshOperation = Extract<
  ScanRefreshOperation,
  { kind: "full-backfill" | "source-backfill" }
>;

export function synchronizesSessionSources(operation: ScanRefreshOperation): boolean {
  return operation.kind === "source-refresh" || operation.kind === "source-backfill";
}

export function isBackfillOperation(
  operation: ScanRefreshOperation,
): operation is BackfillScanRefreshOperation {
  return operation.kind === "full-backfill" || operation.kind === "source-backfill";
}

export function usesDurableCheckpoints(operation: ScanRefreshOperation): boolean {
  return "checkpoint" in operation && operation.checkpoint === "durable";
}
