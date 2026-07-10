/**
 * Transport-layer tests for the /search route.
 *
 * Search semantics (qualifier merge, source selection, recent-path
 * filtering/ordering, FTS/file-activity dedupe, ...) are owned and fully
 * characterized by packages/core/src/search/__tests__/session-search.test.ts
 * via executeSessionSearch. This file only pins the HTTP-layer concerns that
 * live in handleSearchSessions itself: projectKind/projectKey pairing
 * validation, and a couple of smoke tests proving the route wires query
 * params through to the search module and back into the response body.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ScanResult, SessionHead } from "@codesesh/core";
import type { ScanResultSource } from "../handlers.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-search-transport-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

// @codesesh/core's barrel (pulled in transitively by ../routes.js too) eagerly
// reads $HOME/.cache/codesesh at import time (pricing snapshot cache). Both
// must only be imported dynamically, after the node:os mock above is
// registered and testHomeDir exists, or that eager read races the mock and
// throws (accessing testHomeDir before its own initialization).
const { syncSessionSearchIndex } = await import("@codesesh/core");
const { createApiRoutes } = await import("../routes.js");

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

const now = Date.now();

function makeSessionHead(id: string, title: string, timeUpdated: number): SessionHead {
  return {
    id,
    slug: `claudecode/${id}`,
    title,
    directory: `/fixtures/${id}`,
    time_created: timeUpdated,
    time_updated: timeUpdated,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
  };
}

const recentNew = makeSessionHead("recent-new", "plain", now);
const recentMid = makeSessionHead("recent-mid", "plain", now - 1_000);
const recentOld = makeSessionHead("recent-old", "plain", now - 2_000);
const ftsTitle = makeSessionHead("fts-title", "uniquetitleneedle report", now - 3_000);

function makeScanSource(): ScanResultSource {
  const sessions = [recentNew, recentMid, recentOld, ftsTitle];
  return {
    getSnapshot: () =>
      ({
        sessions,
        byAgent: { claudecode: sessions },
        agents: [],
      }) as ScanResult,
  };
}

async function search(app: ReturnType<typeof createApiRoutes>, qs: string) {
  const res = await app.request(`/search${qs}`);
  const body = (await res.json()) as {
    results?: Array<{ agentName: string; session: { id: string }; matchType: string }>;
    error?: string;
  };
  return { status: res.status, body };
}

beforeAll(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  syncSessionSearchIndex("claudecode", [ftsTitle], () => ({
    ...ftsTitle,
    messages: [{ id: `${ftsTitle.id}-m1`, role: "assistant", time_created: now, parts: [] }],
  }));
});

afterAll(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
});

describe("search route: smoke wiring", () => {
  it("routes an empty q to the recent-session path", async () => {
    const app = createApiRoutes(makeScanSource());
    const { body } = await search(app, "");
    expect(body.results!.length).toBeGreaterThan(0);
    expect(body.results!.every((r) => r.matchType === "recent")).toBe(true);
  });

  it("honors limit= on the recent-session path", async () => {
    const app = createApiRoutes(makeScanSource());
    const { body } = await search(app, "?limit=2");
    expect(body.results!.map((r) => r.session.id)).toEqual(["recent-new", "recent-mid"]);
  });

  it("routes a text q to the indexed FTS path and resolves matchType", async () => {
    const app = createApiRoutes(makeScanSource());
    const { body } = await search(app, "?q=uniquetitleneedle");
    expect(body.results!.map((r) => r.session.id)).toEqual(["fts-title"]);
    expect(body.results![0]!.matchType).toBe("title");
  });
});

describe("search route: project identity pairing", () => {
  it("400s when only projectKind is supplied without projectKey", async () => {
    const app = createApiRoutes(makeScanSource());
    const { status, body } = await search(app, "?projectKind=git_remote");
    expect(status).toBe(400);
    expect(body.error).toBe("projectKind and projectKey must form a valid project identity");
  });

  it("400s when only projectKey is supplied without projectKind", async () => {
    const app = createApiRoutes(makeScanSource());
    const { status, body } = await search(app, "?projectKey=github.com/acme/app");
    expect(status).toBe(400);
    expect(body.error).toBe("projectKind and projectKey must form a valid project identity");
  });
});
