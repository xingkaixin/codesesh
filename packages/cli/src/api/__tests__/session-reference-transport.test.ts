import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionRoutePath } from "@codesesh/core/contract";
import type { LiveSnapshot, SessionReference } from "@codesesh/core";

const received = vi.hoisted(() => ({
  detail: vi.fn(),
  deleteBookmark: vi.fn(),
  upsertAlias: vi.fn(),
  deleteAlias: vi.fn(),
}));

vi.mock("@codesesh/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core")>();
  return {
    ...actual,
    materializeSessionDetailResponse: (_snapshot: unknown, reference: SessionReference) => {
      received.detail(reference);
      return { status: "not-found" as const };
    },
    deleteBookmark: received.deleteBookmark,
    upsertSessionAlias: (reference: SessionReference, alias: string) => {
      received.upsertAlias(reference);
      return { reference, alias, updatedAt: 0 };
    },
    deleteSessionAlias: received.deleteAlias,
  };
});

const { createApiRoutes } = await import("../routes.js");

/** Ids whose characters carry URL meaning, so a raw path would split or truncate. */
const OPAQUE_IDS = [
  "plain-session",
  "nested/session",
  "query?part",
  "fragment#part",
  "percent%part",
  "空格 和 unicode ✓",
];

function makeApp() {
  return createApiRoutes({
    getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) as unknown as LiveSnapshot,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CS-132: session reference transport over HTTP", () => {
  it.each(OPAQUE_IDS)("reads a session detail for %j", async (sessionId) => {
    const path = sessionRoutePath({ agentName: "codex", sessionId });

    await makeApp().request(`http://localhost/sessions${path}`);

    expect(received.detail).toHaveBeenCalledWith({ agentName: "codex", sessionId });
  });

  it.each(OPAQUE_IDS)("deletes a bookmark for %j", async (sessionId) => {
    const path = sessionRoutePath({ agentName: "codex", sessionId });

    await makeApp().request(`http://localhost/bookmarks${path}`, { method: "DELETE" });

    expect(received.deleteBookmark).toHaveBeenCalledWith({ agentName: "codex", sessionId });
  });

  it.each(OPAQUE_IDS)("writes and removes an alias for %j", async (sessionId) => {
    const path = sessionRoutePath({ agentName: "codex", sessionId });
    const app = makeApp();

    await app.request(`http://localhost/session-aliases${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "renamed" }),
    });
    await app.request(`http://localhost/session-aliases${path}`, { method: "DELETE" });

    expect(received.upsertAlias).toHaveBeenCalledWith({ agentName: "codex", sessionId });
    expect(received.deleteAlias).toHaveBeenCalledWith({ agentName: "codex", sessionId });
  });
});
