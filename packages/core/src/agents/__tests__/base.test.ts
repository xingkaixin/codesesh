import { describe, it, expect } from "vitest";
import { BaseAgent } from "../base.js";
import type { SessionHead, SessionData } from "../../types/index.js";

/** Concrete implementation for testing abstract base */
class TestAgent extends BaseAgent {
  readonly name = "test";
  readonly displayName = "Test Agent";

  isAvailable() {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(_sessionId: string): SessionData {
    return {} as SessionData;
  }
}

describe("BaseAgent", () => {
  it("getUri returns correct format", () => {
    const agent = new TestAgent();
    expect(agent.getUri("abc123")).toBe("test://abc123");
  });

  it("optional methods are undefined by default", () => {
    const agent = new TestAgent();
    expect(agent.getSessionMetaMap).toBeUndefined();
    expect(agent.setSessionMetaMap).toBeUndefined();
    expect(agent.checkForChanges).toBeUndefined();
    expect(agent.incrementalScan).toBeUndefined();
  });
});
