import { describe, it, expect } from "vitest";
import { createApiRoutes } from "../routes.js";
import type { ScanResult } from "@codesesh/core";
import type { ScanResultSource } from "../handlers.js";

describe("createApiRoutes", () => {
  it("returns a Hono instance with route handlers", () => {
    const scanSource: ScanResultSource = {
      getSnapshot() {
        return {
          sessions: [],
          byAgent: {},
          agents: [],
        } as unknown as ScanResult;
      },
    };
    const app = createApiRoutes(scanSource);
    expect(app).toBeDefined();
    expect(app.fetch).toBeDefined();
  });
});
