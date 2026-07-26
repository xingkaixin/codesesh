import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCursorDataPath, resolveProviderRoots } from "../../discovery/paths.js";
import "../register.js";
import { createRegisteredAgents } from "../registry.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registered agent session watch plans", () => {
  it("requires every adapter to declare a closed watch capability state", () => {
    const agents = createRegisteredAgents();

    expect(agents.map((agent) => agent.name).sort()).toEqual([
      "claudecode",
      "codex",
      "cursor",
      "kimi",
      "opencode",
      "pi",
      "zcode",
    ]);
    for (const agent of agents) {
      expect(["supported", "unsupported", "not-needed"]).toContain(
        agent.getSessionWatchPlan().status,
      );
    }
  });

  it("keeps every existing adapter watch target equivalent", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-home");
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    vi.stubEnv("PI_HOME", "/tmp/pi-home");
    vi.stubEnv("KIMI_SHARE_DIR", "/tmp/kimi-home");
    vi.stubEnv("CURSOR_DATA_PATH", "/tmp/cursor-home");
    vi.stubEnv("XDG_DATA_HOME", "/tmp/data-home");
    const agents = new Map(createRegisteredAgents().map((agent) => [agent.name, agent]));
    const roots = resolveProviderRoots();

    expect(agents.get("claudecode")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [
        { root: roots.claudeRoot, path: join(roots.claudeRoot, "projects") },
        { path: "data/claudecode" },
      ],
    });
    expect(agents.get("codex")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [
        { path: join(roots.codexRoot, "sessions") },
        { path: join(roots.codexRoot, "session_index.jsonl") },
      ],
    });
    expect(agents.get("pi")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [
        { root: roots.piRoot, path: join(roots.piRoot, "agent", "sessions") },
        { root: "data/pi", path: "data/pi" },
      ],
    });
    expect(agents.get("kimi")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [
        { root: roots.kimiRoot, path: join(roots.kimiRoot, "sessions") },
        { path: "data/kimi" },
      ],
    });
    expect(agents.get("cursor")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [
        {
          root: getCursorDataPath(),
          path: join("/tmp/cursor-home", "globalStorage", "state.vscdb"),
        },
        {
          root: getCursorDataPath(),
          path: join("/tmp/cursor-home", "workspaceStorage"),
        },
      ],
    });
    expect(agents.get("opencode")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [
        { root: roots.opencodeRoot, path: join(roots.opencodeRoot, "opencode.db") },
        { root: "data/opencode", path: "data/opencode/opencode.db" },
      ],
    });
    expect(agents.get("zcode")?.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: roots.zcodeRoot
        ? [{ root: roots.zcodeRoot, path: join(roots.zcodeRoot, "cli", "db", "db.sqlite") }]
        : [],
    });
  });
});
