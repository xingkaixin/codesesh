import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentifiedSessionDetail, SessionReference } from "@codesesh/core/contract";
import type { ScanResultSource } from "../scan-sources.js";

const testHome = mkdtempSync(join(tmpdir(), "codesesh-query-scope-"));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testHome,
}));

vi.stubEnv("CODESESH_STATE_DIR", join(testHome, "state"));
vi.stubEnv("CODESESH_LOG_DIR", join(testHome, "logs"));

const { closeCacheStorage, syncSessionSearchIndex } =
  await import("@codesesh/core/runtime/discovery");
const { appLogger } = await import("../../logging.js");
const { createApiRoutes } = await import("../routes.js");

const directory = "/fixtures/scoped-project";
const now = Date.now() - 60_000;

function makeDetail(
  agentName: string,
  sessionId: string,
  project: string,
  time: number,
): IdentifiedSessionDetail {
  return {
    reference: { agentName, sessionId },
    title: "scopeneedle",
    directory: project,
    project_identity: { kind: "path", key: project, displayName: project },
    time_created: time,
    time_updated: time,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    messages: [
      {
        id: `${sessionId}-message`,
        role: "assistant",
        time_created: time,
        parts: [
          { type: "text", text: "scopeneedle" },
          {
            type: "tool",
            tool: "Read",
            state: { status: "completed", input: { file_path: "src/scoped.ts" } },
          },
        ],
      },
    ],
  };
}

const visible = makeDetail("codex", "visible", directory, now);
const otherProject = makeDetail("codex", "other-project", "/fixtures/other-project", now + 1_000);
const otherAgent = makeDetail("claudecode", "other-agent", directory, now + 2_000);
const source: ScanResultSource = {
  queryScope: {
    agents: ["codex"],
    projectScope: { identity: { kind: "path", key: directory }, path: directory },
  },
  getSnapshot: () => ({ sessions: [], byAgent: { codex: [] }, agents: [] }),
};

const app = createApiRoutes(source);

async function references(path: string, collection: string): Promise<SessionReference[]> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, Array<{ reference: SessionReference }>>;
  return body[collection]!.map((item) => item.reference);
}

beforeAll(() => {
  for (const [agent, details] of [
    ["codex", [visible, otherProject]],
    ["claudecode", [otherAgent]],
  ] as const) {
    syncSessionSearchIndex(agent, [...details], (sessionId) =>
      details.find((detail) => detail.reference.sessionId === sessionId)!,
    );
  }
});

afterAll(async () => {
  await appLogger.flush();
  closeCacheStorage();
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});

describe("instance query scope across indexed API reads", () => {
  it.each([
    ["/search?days=0&q=scopeneedle&limit=1", "results"],
    ["/file-activity?days=0&limit=1", "activity"],
    ["/dashboard?days=0", "recentFileActivities"],
  ])("limits %s before pagination even while the live snapshot is empty", async (path, field) => {
    expect(await references(path, field)).toEqual([visible.reference]);
  });

  it.each([
    ["/search?days=0&q=scopeneedle%20agent:claudecode", "results"],
    ["/file-activity?days=0&agent=claudecode", "activity"],
    [
      "/dashboard?days=0&projectKind=path&projectKey=/fixtures/other-project",
      "recentFileActivities",
    ],
  ])("does not let request filters widen the instance scope: %s", async (path, field) => {
    expect(await references(path, field)).toEqual([]);
  });
});
