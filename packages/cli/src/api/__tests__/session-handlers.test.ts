import { describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionHead } from "@codesesh/core/runtime/discovery";
import { appLogger } from "../../logging.js";
import {
  ProjectIdentityQueueFullError,
  ProjectIdentityRequestAbortedError,
} from "../../project-identity-resolver.js";
import { SessionDetailBusyError } from "../../session-detail-loader.js";
import type { ScanResultSource } from "../scan-sources.js";
import {
  coreMocks,
  makeMockContext,
  makeProjectIdentityResolver,
  makeScanResult,
  makeScanSource,
  makeSession,
} from "./handler-test-fixtures.js";

const { handleGetSessionData, handleGetSessions } = await import("../session-handlers.js");
const { invalidateAliasView } = await import("../session-aliases-view.js");

describe("handleGetSessions", () => {
  it("returns all sessions without filters", () => {
    const c = makeMockContext();
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(2);
  });

  it("omits server-only metadata from list responses", () => {
    const session = makeSession("usage", {
      model_usage: { "gpt-5.5": 120 },
      project_identity_resolver_revision: "resolver-v2",
      project_identity_input_signature: "signature",
      smart_tags_source_updated_at: 123,
      smart_tags_classifier_revision: "classifier-v2",
    });
    const source = makeScanSource({
      sessions: [session],
      byAgent: { claudecode: [session] },
    });
    const c = makeMockContext();

    handleGetSessions(c, source);

    const response = c.json.mock.calls[0]![0].sessions[0];
    expect(response).not.toHaveProperty("model_usage");
    expect(response).not.toHaveProperty("project_identity_resolver_revision");
    expect(response).not.toHaveProperty("project_identity_input_signature");
    expect(response).not.toHaveProperty("smart_tags_source_updated_at");
    expect(response).not.toHaveProperty("smart_tags_classifier_revision");
    expect(session.model_usage).toEqual({ "gpt-5.5": 120 });
  });

  it("returns cursor pages without changing legacy unpaged requests", () => {
    const sessions = [makeSession("first"), makeSession("second"), makeSession("third")];
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    const firstContext = makeMockContext({ query: { limit: "2" } });

    handleGetSessions(firstContext, source);

    const firstPage = firstContext.json.mock.calls[0]![0];
    expect(firstPage.sessions.map((session: SessionHead) => session.reference.sessionId)).toEqual([
      "first",
      "second",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondContext = makeMockContext({
      query: { limit: "2", cursor: firstPage.nextCursor },
    });
    handleGetSessions(secondContext, source);

    expect(secondContext.json.mock.calls[0]![0]).toEqual({ sessions: [sessions[2]] });

    const legacyContext = makeMockContext();
    handleGetSessions(legacyContext, source);
    expect(legacyContext.json.mock.calls[0]![0].sessions).toHaveLength(3);
  });

  it("finishes the original session snapshot while new scans are published", () => {
    vi.useFakeTimers();
    const initialSessions = [makeSession("first"), makeSession("second")];
    let snapshot = makeScanResult({
      sessions: initialSessions,
      byAgent: { claudecode: initialSessions },
    });
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    const firstContext = makeMockContext({ query: { limit: "1" } });
    handleGetSessions(firstContext, source);
    const cursor = firstContext.json.mock.calls[0]![0].nextCursor;

    const updatedSessions = [makeSession("new"), ...initialSessions];
    snapshot = makeScanResult({
      sessions: updatedSessions,
      byAgent: { claudecode: updatedSessions },
    });
    const nextContext = makeMockContext({ query: { limit: "1", cursor } });
    handleGetSessions(nextContext, source);

    expect(nextContext.json).toHaveBeenCalledWith({ sessions: [initialSessions[1]] });

    const freshContext = makeMockContext({ query: { limit: "1" } });
    handleGetSessions(freshContext, source);
    expect(freshContext.json.mock.calls[0]![0].sessions).toEqual([updatedSessions[0]]);

    vi.advanceTimersByTime(60_000);
    const expired = makeMockContext({ query: { limit: "1", cursor } });
    handleGetSessions(expired, source);
    expect(expired.json).toHaveBeenCalledWith(
      { error: "session snapshot expired; restart pagination" },
      409,
    );
  });

  it("keeps alias-filtered pages on their original alias view", () => {
    const sessions = [makeSession("first"), makeSession("second")];
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    coreMocks.listSessionAliases.mockReturnValue(
      sessions.map((session) => ({ reference: session.reference, alias: "Saved", updatedAt: 1 })),
    );
    const first = makeMockContext({ query: { limit: "1", q: "saved" } });
    handleGetSessions(first, source);

    coreMocks.listSessionAliases.mockReturnValue([]);
    invalidateAliasView();
    const next = makeMockContext({
      query: { limit: "1", q: "saved", cursor: first.json.mock.calls[0]![0].nextCursor },
    });
    handleGetSessions(next, source);

    expect(next.json).toHaveBeenCalledWith({
      sessions: [{ ...sessions[1], display_title: "Saved" }],
    });
    const fresh = makeMockContext({ query: { limit: "1", q: "saved" } });
    handleGetSessions(fresh, source);
    expect(fresh.json).toHaveBeenCalledWith({ sessions: [] });
  });

  it("rejects invalid pagination parameters", () => {
    const invalidLimit = makeMockContext({ query: { limit: "many" } });
    handleGetSessions(invalidLimit, makeScanSource());
    expect(invalidLimit.json).toHaveBeenCalledWith(
      { error: "limit must be a positive integer" },
      400,
    );

    const invalidCursor = makeMockContext({ query: { cursor: "not-a-cursor" } });
    handleGetSessions(invalidCursor, makeScanSource());
    expect(invalidCursor.json).toHaveBeenCalledWith(
      { error: "cursor is invalid for this request" },
      400,
    );
  });

  it("reuses filtered candidates across pages from the same snapshot", () => {
    const sessions = [
      makeSession("first", {
        project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
      }),
      makeSession("second", {
        project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
      }),
    ];
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    const firstContext = makeMockContext({
      query: { limit: "1", projectKind: "path", projectKey: "/workspace" },
    });
    handleGetSessions(firstContext, source);

    const nextContext = makeMockContext({
      query: {
        limit: "1",
        cursor: firstContext.json.mock.calls[0]![0].nextCursor,
        projectKind: "path",
        projectKey: "/workspace",
      },
    });
    handleGetSessions(nextContext, source);

    expect(coreMocks.matchesProjectIdentity).toHaveBeenCalledTimes(sessions.length);
  });

  it("filters by agent", () => {
    const c = makeMockContext({ query: { agent: "claudecode" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(2);
  });

  it("returns no sessions when the requested agent is unknown", () => {
    const c = makeMockContext({ query: { agent: "nonexistent" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toEqual([]);
  });

  it("normalizes the requested agent case", () => {
    const c = makeMockContext({ query: { agent: "ClaudeCode" } });

    handleGetSessions(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].sessions).toHaveLength(2);
  });

  it("filters by q (title search)", () => {
    const c = makeMockContext({ query: { q: "s1" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].reference.sessionId).toBe("s1");
  });

  it("projects a persisted alias without changing the source title", () => {
    coreMocks.listSessionAliases.mockReturnValue([
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        alias: "Fix session cache refresh",
        updatedAt: Date.now(),
      },
    ]);
    const c = makeMockContext();

    handleGetSessions(c, makeScanSource());

    const session = c.json.mock.calls[0]![0].sessions[0];
    expect(session).toMatchObject({
      title: "Session s1",
      display_title: "Fix session cache refresh",
    });
  });

  it("uses the structured reference to resolve aliases", () => {
    const session = {
      ...makeSession("legacy", {
        reference: { agentName: "unknown", sessionId: "legacy" },
      }),
    };
    coreMocks.listSessionAliases.mockReturnValue([
      {
        reference: { agentName: "unknown", sessionId: "legacy" },
        alias: "Legacy alias",
        updatedAt: 1,
      },
    ]);
    const c = makeMockContext();

    handleGetSessions(
      c,
      makeScanSource({ sessions: [session], byAgent: { claudecode: [session] } }),
    );

    expect(c.json.mock.calls[0]![0].sessions[0].display_title).toBe("Legacy alias");
  });

  it("filters by cwd using project scope match", async () => {
    const sessions = [
      makeSession("exact", { directory: "/home/user/project" }),
      makeSession("child", { directory: "/home/user/project/src" }),
      makeSession("parent", { directory: "/home/user" }),
      makeSession("identity", {
        directory: "/elsewhere",
        project_identity: {
          kind: "path",
          key: "/home/user/project",
          displayName: "project",
        },
      }),
      makeSession("sibling", { directory: "/home/user/projectile" }),
    ];
    const c = makeMockContext({ query: { cwd: "/home/user/project" } });
    const resolver = makeProjectIdentityResolver();
    await handleGetSessions(
      c,
      makeScanSource({ sessions, byAgent: { claudecode: sessions } }),
      {},
      resolver,
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions.map((session: SessionHead) => session.reference.sessionId)).toEqual([
      "exact",
      "child",
      "parent",
      "identity",
    ]);
    expect(resolver.resolve).toHaveBeenCalledWith("/home/user/project", expect.any(AbortSignal));
  });

  it("returns 429 when project identity capacity is exhausted", async () => {
    const c = makeMockContext({ query: { cwd: "/home/user/project" } });
    const resolver = makeProjectIdentityResolver();
    vi.mocked(resolver.resolve).mockRejectedValue(new ProjectIdentityQueueFullError());

    await handleGetSessions(c, makeScanSource(), {}, resolver);

    expect(c.json).toHaveBeenCalledWith({ error: "Project scope busy; retry later" }, 429);
  });

  it("returns 503 when project identity resolution fails", async () => {
    const c = makeMockContext({ query: { cwd: "/home/user/project" } });
    const resolver = makeProjectIdentityResolver();
    vi.mocked(resolver.resolve).mockRejectedValue(new Error("worker failed"));

    await handleGetSessions(c, makeScanSource(), {}, resolver);

    expect(c.json).toHaveBeenCalledWith({ error: "Project scope unavailable" }, 503);
  });

  it("propagates request cancellation into project identity resolution", async () => {
    const controller = new AbortController();
    const c = makeMockContext({
      query: { cwd: "/home/user/project" },
      signal: controller.signal,
    });
    const resolver = makeProjectIdentityResolver();
    vi.mocked(resolver.resolve).mockImplementation(
      async (_cwd, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new ProjectIdentityRequestAbortedError()),
            { once: true },
          );
        }),
    );

    const response = handleGetSessions(c, makeScanSource(), {}, resolver);
    controller.abort();

    await expect(response).rejects.toBeInstanceOf(ProjectIdentityRequestAbortedError);
  });

  it("filters by project identity key", () => {
    const sessions = [
      makeSession("a", {
        project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
      }),
      makeSession("b", {
        project_identity: { kind: "path", key: "/home/user/other", displayName: "other" },
      }),
      makeSession("same-key-path", {
        project_identity: {
          kind: "path",
          key: "github.com/acme/app",
          displayName: "app path",
        },
      }),
    ];
    const c = makeMockContext({
      query: { projectKind: "git_remote", projectKey: "github.com/acme/app" },
    });
    handleGetSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions.map((session: SessionHead) => session.reference.sessionId)).toEqual([
      "a",
    ]);
  });

  it("filters by from date", () => {
    const c = makeMockContext({ query: { from: "2024-01-01" } });
    handleGetSessions(
      c,
      makeScanSource({
        sessions: [
          makeSession("old", {
            time_created: new Date("2023-01-01").getTime(),
            time_updated: new Date("2023-01-01").getTime(),
          }),
          makeSession("new", {
            time_created: new Date("2023-01-01").getTime(),
            time_updated: new Date("2025-01-01").getTime(),
          }),
        ],
        byAgent: {},
      }),
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].reference.sessionId).toBe("new");
  });

  it("uses activity time instead of creation time for session filters", () => {
    const now = Date.now();
    const c = makeMockContext({ query: { from: new Date(now - 7 * 86400000).toISOString() } });
    handleGetSessions(
      c,
      makeScanSource({
        sessions: [
          makeSession("old-active", {
            time_created: now - 90 * 86400000,
            time_updated: now - 60_000,
          }),
          makeSession("old-idle", {
            time_created: now - 90 * 86400000,
            time_updated: now - 90 * 86400000,
          }),
        ],
        byAgent: {},
      }),
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].reference.sessionId).toBe("old-active");
  });

  it("rejects an invalid from date", () => {
    const c = makeMockContext({ query: { from: "not-a-date" } });
    handleGetSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "from must be a valid date" }, 400);
  });

  it("rejects a date window whose start is after its end", () => {
    const c = makeMockContext({ query: { from: "2026-08-13", to: "2026-08-12" } });
    handleGetSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "from must not be after to" }, 400);
  });
});

describe("handleGetSessionData", () => {
  it("returns a retryable response when detail workers are at capacity", async () => {
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    const header = vi.fn();
    Object.assign(c, { header });
    await handleGetSessionData(c, makeScanSource(), async () => {
      throw new SessionDetailBusyError();
    });
    expect(c.json).toHaveBeenCalledWith({ error: "Session details busy; retry later" }, 503);
    expect(header).toHaveBeenCalledWith("Retry-After", "1");
  });

  const detail: SessionDetail = {
    reference: { agentName: "claudecode", sessionId: "s1" },
    title: "Test Session",
    directory: "/home/user/project",
    time_created: 1000,
    time_updated: 1000,
    messages: [],
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    project_identity: {
      kind: "path",
      key: "/home/user/project",
      displayName: "project",
    },
    smart_tags: [],
    smart_tags_source_updated_at: 1000,
    file_activity: [],
  };

  it("maps materialized session data to JSON", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "found", data: detail });
    const scanSource = makeScanSource();
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    await handleGetSessionData(c, scanSource);

    expect(coreMocks.materializeSessionDetailResponse).toHaveBeenCalledWith(
      scanSource.getSnapshot(),
      {
        agentName: "claudecode",
        sessionId: "s1",
      },
      {},
      c.req.raw.signal,
    );
    expect(c.json).toHaveBeenCalledWith(detail);
  });

  it("forwards an incremental message cursor to detail materialization", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "found", data: detail });
    const scanSource = makeScanSource();
    const c = makeMockContext({
      param: { agent: "claudecode", id: "s1" },
      query: { messageCursor: "known-prefix" },
    });

    await handleGetSessionData(c, scanSource);

    expect(coreMocks.materializeSessionDetailResponse).toHaveBeenCalledWith(
      scanSource.getSnapshot(),
      { agentName: "claudecode", sessionId: "s1" },
      { messageCursor: "known-prefix" },
      c.req.raw.signal,
    );
  });

  it("streams cached message JSON lazily while preserving aliases", async () => {
    const { messages: _messages, ...detailHeader } = detail;
    let serializedMessages = 0;
    function* messages() {
      for (let index = 0; index < 200; index += 1) {
        serializedMessages += 1;
        yield JSON.stringify({
          id: `m${index}`,
          role: "assistant",
          agent: null,
          time_created: 1000,
          time_completed: null,
          mode: null,
          model: null,
          provider: null,
          parts: [{ type: "text", text: "cached".repeat(100) }],
        });
      }
    }
    coreMocks.listSessionAliases.mockReturnValue([
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        alias: "Local Alias",
        updatedAt: 1000,
      },
    ]);
    coreMocks.materializeSessionDetailResponse.mockReturnValue({
      status: "found-json",
      data: detailHeader,
      messages: messages(),
      messageCount: 200,
      sentMessageCount: 200,
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    const response = await handleGetSessionData(c, makeScanSource());

    expect(response).toBeInstanceOf(Response);
    expect(serializedMessages).toBe(0);
    expect(c.json).not.toHaveBeenCalled();
    const reader = (response as Response).body!.getReader();
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let json = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      json += decoder.decode(result.value, { stream: true });
    }
    json += decoder.decode();
    const payload = JSON.parse(json);
    expect(payload.reference).toEqual({ agentName: "claudecode", sessionId: "s1" });
    expect(payload.display_title).toBe("Local Alias");
    expect(payload.messages[0].id).toBe("m0");
    expect(payload.messages).toHaveLength(200);
    expect(chunks.length).toBeLessThan(10);
    expect(serializedMessages).toBe(200);
  });

  it("errors the response body and closes iteration when cached message reads fail", async () => {
    const { messages: _messages, ...detailHeader } = detail;
    const iterator = {
      next: vi
        .fn()
        .mockReturnValueOnce({ done: false, value: JSON.stringify({ id: "m1" }) })
        .mockImplementationOnce(() => {
          throw new Error("cached message read failed");
        }),
      return: vi.fn(() => ({ done: true, value: undefined })),
    };
    coreMocks.materializeSessionDetailResponse.mockReturnValue({
      status: "found-json",
      data: detailHeader,
      messages: { [Symbol.iterator]: () => iterator },
      messageCount: 2,
      sentMessageCount: 2,
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    const response = (await handleGetSessionData(c, makeScanSource())) as Response;

    await expect(response.text()).rejects.toThrow("cached message read failed");
    expect(iterator.return).toHaveBeenCalledOnce();
  });

  it("returns 400 when agent name is missing", async () => {
    const c = makeMockContext({ param: { agent: "", id: "s1" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "Missing agent name" }, 400);
    expect(coreMocks.materializeSessionDetailResponse).not.toHaveBeenCalled();
  });

  it("returns 400 when session ID is missing", async () => {
    const c = makeMockContext({ param: { agent: "claudecode", id: "" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "Missing session ID" }, 400);
    expect(coreMocks.materializeSessionDetailResponse).not.toHaveBeenCalled();
  });

  it("maps an unknown agent to 404", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "unknown-agent" });
    const c = makeMockContext({ param: { agent: "unknown", id: "s1" } });

    await handleGetSessionData(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "Unknown agent: unknown" }, 404);
  });

  it("maps unavailable detail to 404", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "not-ready" });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    await handleGetSessionData(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "Session cache not ready" }, 404);
  });

  it("maps materialization errors to 500", async () => {
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    coreMocks.materializeSessionDetailResponse.mockImplementation(() => {
      throw new Error("ENOENT: open '/Users/private/.claude/session.json'");
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    try {
      await handleGetSessionData(c, makeScanSource());

      expect(c.json).toHaveBeenCalledWith({ error: "Failed to load session" }, 500);
      expect(errorSpy).toHaveBeenCalledWith(
        "api.session_data.error",
        expect.objectContaining({ error: "ENOENT: open '/Users/private/.claude/session.json'" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
