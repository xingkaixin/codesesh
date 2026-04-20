import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAgent } from "../codex.js";
import type { SessionHead } from "../../types/index.js";

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/tmp/project",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

describe("CodexAgent cache refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects file set changes even when file count stays the same", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const oldA = join(tempDir, "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const newC = join(tempDir, "rollout-2026-04-20T10-05-00-019dcccc-cccc-7ccc-cccc-cccccccccccc.jsonl");

    writeFileSync(oldA, '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n');
    writeFileSync(newC, '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:05:00Z"}}\n');

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        { id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa", sourcePath: oldA },
      ],
      [
        "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
        {
          id: "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
          sourcePath: join(tempDir, "missing.jsonl"),
        },
      ],
    ]);
    agent.listRolloutFiles = () => [oldA, newC];

    const result = agent.checkForChanges(Date.now(), [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
      makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb");
  });

  it("removes deleted sessions and adds new sessions during incremental scan", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const oldA = join(tempDir, "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const newC = join(tempDir, "rollout-2026-04-20T10-05-00-019dcccc-cccc-7ccc-cccc-cccccccccccc.jsonl");

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(oldA, "");
    writeFileSync(newC, "");

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        { id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa", sourcePath: oldA },
      ],
      [
        "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
        {
          id: "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
          sourcePath: join(tempDir, "missing.jsonl"),
        },
      ],
    ]);
    agent.listRolloutFiles = () => [oldA, newC];
    agent.parseSessionHead = (file: string) => {
      if (file === oldA) return makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa");
      if (file === newC) return makeSession("019dcccc-cccc-7ccc-cccc-cccccccccccc");
      return null;
    };

    const sessions = agent.incrementalScan(
      [
        makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
        makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
      ],
      ["019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"],
    );

    expect(sessions.map((session: SessionHead) => session.id).sort()).toEqual([
      "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      "019dcccc-cccc-7ccc-cccc-cccccccccccc",
    ]);
    expect(agent.sessionMetaMap.has("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb")).toBe(false);
  });
});
