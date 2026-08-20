import { describe, expect, it } from "vitest";
import {
  isBackfillOperation,
  scanIntentForOperation,
  usesDurableCheckpoints,
  type ScanRefreshOperation,
} from "./scan-refresh-operation.js";

describe("ScanRefreshOperation", () => {
  it.each<{
    operation: ScanRefreshOperation;
    backfill: boolean;
    durableCheckpoints: boolean;
    intent: "reload" | "refresh" | "recompute-derived" | "backfill";
  }>([
    {
      operation: { kind: "full-scan" },
      backfill: false,
      durableCheckpoints: false,
      intent: "reload",
    },
    {
      operation: { kind: "source-refresh", checkpoint: "durable" },
      backfill: false,
      durableCheckpoints: true,
      intent: "refresh",
    },
    {
      operation: { kind: "recompute-derived" },
      backfill: false,
      durableCheckpoints: false,
      intent: "recompute-derived",
    },
    {
      operation: { kind: "backfill", cursor: "cursor", checkpoint: "durable" },
      backfill: true,
      durableCheckpoints: true,
      intent: "backfill",
    },
  ])(
    "classifies $operation.kind without boolean mode inference",
    ({ operation, backfill, durableCheckpoints, intent }) => {
      expect(isBackfillOperation(operation)).toBe(backfill);
      expect(usesDurableCheckpoints(operation)).toBe(durableCheckpoints);
      expect(scanIntentForOperation(operation)).toBe(intent);
    },
  );
});
