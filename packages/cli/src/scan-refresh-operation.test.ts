import { describe, expect, it } from "vitest";
import {
  isBackfillOperation,
  synchronizesSessionSources,
  usesDurableCheckpoints,
  type ScanRefreshOperation,
} from "./scan-refresh-operation.js";

describe("ScanRefreshOperation", () => {
  it.each<{
    operation: ScanRefreshOperation;
    sourceSynchronization: boolean;
    backfill: boolean;
    durableCheckpoints: boolean;
  }>([
    {
      operation: { kind: "full-scan" },
      sourceSynchronization: false,
      backfill: false,
      durableCheckpoints: false,
    },
    {
      operation: { kind: "incremental-scan", changedIds: ["one"] },
      sourceSynchronization: false,
      backfill: false,
      durableCheckpoints: false,
    },
    {
      operation: { kind: "source-refresh", checkpoint: "durable" },
      sourceSynchronization: true,
      backfill: false,
      durableCheckpoints: true,
    },
    {
      operation: { kind: "recompute-derived" },
      sourceSynchronization: false,
      backfill: false,
      durableCheckpoints: false,
    },
    {
      operation: { kind: "full-backfill", cursor: "cursor" },
      sourceSynchronization: false,
      backfill: true,
      durableCheckpoints: false,
    },
    {
      operation: { kind: "source-backfill", cursor: "cursor", checkpoint: "durable" },
      sourceSynchronization: true,
      backfill: true,
      durableCheckpoints: true,
    },
  ])(
    "classifies $operation.kind without boolean mode inference",
    ({ operation, sourceSynchronization, backfill, durableCheckpoints }) => {
      expect(synchronizesSessionSources(operation)).toBe(sourceSynchronization);
      expect(isBackfillOperation(operation)).toBe(backfill);
      expect(usesDurableCheckpoints(operation)).toBe(durableCheckpoints);
    },
  );
});
