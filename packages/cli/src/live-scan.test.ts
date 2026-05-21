import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWatchTargets } from "./live-scan.js";

describe("resolveAgentWatchTargets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("covers Codex session files nested by year/month/day", () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");

    expect(resolveAgentWatchTargets("codex")).toEqual([
      { path: join("/tmp/codex-home", "sessions") },
      { path: join("/tmp/codex-home", "session_index.jsonl") },
    ]);
  });

  it("keeps Claude Code watch depth aligned with project/session layout", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-home");

    expect(resolveAgentWatchTargets("claudecode")).toEqual([
      { root: "/tmp/claude-home", path: join("/tmp/claude-home", "projects") },
      { path: "data/claudecode" },
    ]);
  });
});
