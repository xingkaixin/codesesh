import { describe, expect, it } from "vitest";
import {
  isBackfillOperation,
  usesDurableCheckpoints,
  type ScanRefreshOperation,
} from "./scan-refresh-operation.js";

describe("ScanRefreshOperation", () => {
  it.each<{
    operation: ScanRefreshOperation;
    backfill: boolean;
    durableCheckpoints: boolean;
  }>([
    {
      operation: { kind: "full-scan" },
      backfill: false,
      durableCheckpoints: false,
    },
    {
      operation: { kind: "source-refresh", checkpoint: "durable" },
      backfill: false,
      durableCheckpoints: true,
    },
    {
      operation: { kind: "recompute-derived" },
      backfill: false,
      durableCheckpoints: false,
    },
    {
      operation: { kind: "backfill", cursor: "cursor", checkpoint: "durable" },
      backfill: true,
      durableCheckpoints: true,
    },
  ])(
    "classifies $operation.kind without boolean mode inference",
    ({ operation, backfill, durableCheckpoints }) => {
      expect(isBackfillOperation(operation)).toBe(backfill);
      expect(usesDurableCheckpoints(operation)).toBe(durableCheckpoints);
    },
  );
});
