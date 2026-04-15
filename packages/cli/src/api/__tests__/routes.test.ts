import { describe, it, expect } from "vitest";
import { createApiRoutes } from "../routes.js";
import type { ScanResult } from "@agent-lens/core";

describe("createApiRoutes", () => {
  it("returns a Hono instance with route handlers", () => {
    const scanResult = {
      sessions: [],
      byAgent: {},
      agents: [],
    } as unknown as ScanResult;
    const app = createApiRoutes(scanResult);
    expect(app).toBeDefined();
    expect(app.fetch).toBeDefined();
  });
});
