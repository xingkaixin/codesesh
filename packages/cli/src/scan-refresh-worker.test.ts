import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BaseAgent, SessionHead } from "@codesesh/core";
import { finalizeSessions } from "./scan-refresh-worker.js";

// Isolated temp directory so computeIdentity resolves a stable "path" identity
// regardless of manifests that happen to exist above /tmp.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codesesh-scan-refresh-worker-"));

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: id,
    directory: FIXTURE_DIR,
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function makeAgent(getSessionData: BaseAgent["getSessionData"]): BaseAgent {
  return {
    name: "codex",
    displayName: "Codex",
    isAvailable: () => true,
    scan: () => [],
    incrementalScan: () => [],
    getSessionData,
    getSessionMetaMap: () => new Map(),
    setSessionMetaMap: () => undefined,
  } as unknown as BaseAgent;
}

describe("finalizeSessions", () => {
  it("attaches project identity to sessions missing one", () => {
    const agent = makeAgent(() => ({ messages: [] }) as never);
    const [result] = finalizeSessions(agent, [makeSession("s1")]);

    expect(result?.project_identity).toEqual({
      kind: "path",
      key: FIXTURE_DIR,
      displayName: FIXTURE_DIR.split(/[\\/]/).pop(),
    });
  });

  it("computes smart tags for a session whose content changed", () => {
    const getSessionData = vi.fn(() => ({
      time_created: 1000,
      time_updated: 1000,
      messages: [{ role: "user", parts: [{ type: "text", text: "fix the crash" }] }],
    })) as unknown as BaseAgent["getSessionData"];
    const agent = makeAgent(getSessionData);

    const [result] = finalizeSessions(agent, [makeSession("s1")]);

    expect(getSessionData).toHaveBeenCalledWith("s1");
    expect(result?.smart_tags).toContain("bugfix");
    expect(result?.smart_tags_source_updated_at).toBe(1000);
  });

  it("does not recompute tags for a session whose tags are already current", () => {
    const getSessionData = vi.fn();
    const agent = makeAgent(getSessionData as unknown as BaseAgent["getSessionData"]);

    const session = makeSession("s1", {
      smart_tags: ["bugfix"],
      smart_tags_source_updated_at: 1000,
    });

    const [result] = finalizeSessions(agent, [session]);

    expect(getSessionData).not.toHaveBeenCalled();
    expect(result?.smart_tags).toEqual(["bugfix"]);
  });

  it("skips tag computation for a session still within the settle window", () => {
    const getSessionData = vi.fn();
    const agent = makeAgent(getSessionData as unknown as BaseAgent["getSessionData"]);

    const hotSession = makeSession("hot", { time_updated: Date.now() - 10_000 });
    const settledSession = makeSession("settled");

    const result = finalizeSessions(agent, [hotSession, settledSession]);

    expect(getSessionData).toHaveBeenCalledTimes(1);
    expect(getSessionData).toHaveBeenCalledWith("settled");
    expect(result.map((session) => session.id)).toEqual(["hot", "settled"]);
    expect(result[0]?.smart_tags).toBeUndefined();
  });
});
