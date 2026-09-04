import { describe, expect, it, vi } from "vitest";
import type {
  BookmarkView,
  LiveSnapshot,
  ScanResultSource,
} from "./state-handler-test-fixtures.js";
import {
  availableBookmark,
  bookmarkScanSource,
  coreMocks,
  getResponsePayload,
  legacyBookmark,
  loggerMocks,
  makeContext,
  scanSource,
  sessionHead,
  storedBookmark,
  validReference,
} from "./state-handler-test-fixtures.js";

const {
  BookmarkStorageUnavailableError,
  SessionAliasValidationError,
  StateStorageUnavailableError,
} = await import("@codesesh/core/runtime/state");
const {
  handleDeleteBookmark,
  handleDeleteSessionAlias,
  handleGetBookmarks,
  handleImportBookmarks,
  handlePutBookmark,
  handlePutSessionAlias,
} = await import("../bookmark-handlers.js");
const { createApiRoutes } = await import("../routes.js");

describe("bookmark handlers", () => {
  it("materializes current session data and decorates it with aliases", () => {
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    coreMocks.listSessionAliases.mockReturnValue([
      { reference: validReference, alias: "Renamed", updatedAt: 1 },
    ]);
    const c = makeContext();

    handleGetBookmarks(c as never, bookmarkScanSource);

    expect(c.json).toHaveBeenCalledWith({
      bookmarks: [
        {
          ...availableBookmark,
          session: { ...sessionHead, display_title: "Renamed" },
        },
      ],
      storageAvailable: true,
    });
    expect(coreMocks.upsertBookmark).not.toHaveBeenCalled();
    expect(coreMocks.importBookmarks).not.toHaveBeenCalled();
  });

  it("omits internal metadata from available sessions", () => {
    const internalSession = {
      ...sessionHead,
      model_usage: { "gpt-5.5": 5 },
      project_identity_resolver_revision: "resolver-v2",
      project_identity_input_signature: "signature",
      smart_tags_source_updated_at: 2,
      smart_tags_classifier_revision: "classifier-v2",
    };
    const source: ScanResultSource = {
      getSnapshot: () =>
        ({
          sessions: [internalSession],
          byAgent: { codex: [internalSession] },
          agents: [],
        }) as LiveSnapshot,
    };
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    const c = makeContext();

    handleGetBookmarks(c as never, source);

    const bookmark = getResponsePayload<{ bookmarks: BookmarkView[] }>(c).bookmarks[0];
    const responseSession = bookmark?.availability === "available" ? bookmark.session : undefined;
    expect(responseSession).not.toHaveProperty("model_usage");
    expect(responseSession).not.toHaveProperty("project_identity_resolver_revision");
    expect(responseSession).not.toHaveProperty("project_identity_input_signature");
    expect(responseSession).not.toHaveProperty("smart_tags_source_updated_at");
    expect(responseSession).not.toHaveProperty("smart_tags_classifier_revision");
    expect(internalSession.model_usage).toEqual({ "gpt-5.5": 5 });
  });

  it("tolerates unavailable alias storage and logs unexpected alias failures", () => {
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw new StateStorageUnavailableError();
    });
    handleGetBookmarks(makeContext() as never, bookmarkScanSource);
    expect(loggerMocks.warn).not.toHaveBeenCalled();

    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw new Error("corrupt aliases");
    });
    handleGetBookmarks(makeContext() as never, bookmarkScanSource);
    expect(loggerMocks.warn).toHaveBeenLastCalledWith("api.session_aliases.load_failed", {
      error: "corrupt aliases",
    });

    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw "invalid aliases";
    });
    handleGetBookmarks(makeContext() as never, bookmarkScanSource);
    expect(loggerMocks.warn).toHaveBeenLastCalledWith("api.session_aliases.load_failed", {
      error: "invalid aliases",
    });
  });

  it("reports unavailable bookmark storage and rethrows unexpected failures", () => {
    coreMocks.listBookmarks.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext();
    handleGetBookmarks(unavailable as never, bookmarkScanSource);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Bookmark storage is unavailable" },
      503,
    );

    coreMocks.listBookmarks.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    expect(() => handleGetBookmarks(makeContext() as never, bookmarkScanSource)).toThrow(
      "unexpected",
    );
  });

  it.each([
    null,
    {},
    { reference: { agentName: 1, sessionId: "s1" } },
    { reference: { agentName: "codex", sessionId: 1 } },
    { reference: { agentName: " ", sessionId: "s1" } },
    { reference: { agentName: "codex", sessionId: "" } },
    { agentKey: 1, sessionId: "s1" },
  ])("rejects invalid bookmark identity payload %#", async (body) => {
    const c = makeContext({ body });

    await handlePutBookmark(c as never);

    expect(c.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);
    expect(coreMocks.upsertBookmark).not.toHaveBeenCalled();
  });

  it("rejects writes referencing agents that do not exist", async () => {
    const put = makeContext({ body: { reference: { agentName: "ghost", sessionId: "s1" } } });
    await handlePutBookmark(put as never);
    expect(put.json).toHaveBeenCalledWith({ error: "Unknown agent: ghost" }, 400);
    expect(coreMocks.upsertBookmark).not.toHaveBeenCalled();

    const del = makeContext({ param: { agent: "ghost", id: "s1" } });
    await handleDeleteBookmark(del as never);
    expect(del.json).toHaveBeenCalledWith({ error: "Unknown agent: ghost" }, 400);
    expect(coreMocks.deleteBookmark).not.toHaveBeenCalled();

    const putAlias = makeContext({
      param: { agent: "ghost", id: "s1" },
      body: { alias: "renamed" },
    });
    await handlePutSessionAlias(putAlias as never);
    expect(putAlias.json).toHaveBeenCalledWith({ error: "Unknown agent: ghost" }, 400);
    expect(coreMocks.upsertSessionAlias).not.toHaveBeenCalled();

    const delAlias = makeContext({ param: { agent: "ghost", id: "s1" } });
    await handleDeleteSessionAlias(delAlias as never);
    expect(delAlias.json).toHaveBeenCalledWith({ error: "Unknown agent: ghost" }, 400);
    expect(coreMocks.deleteSessionAlias).not.toHaveBeenCalled();
  });

  it("skips unknown agents in bookmark imports and reports the count", async () => {
    const mixed = makeContext({
      body: [storedBookmark, { reference: { agentName: "ghost", sessionId: "s9" } }],
    });

    await handleImportBookmarks(mixed as never, bookmarkScanSource);

    expect(coreMocks.importBookmarks).toHaveBeenCalledWith([storedBookmark]);
    expect(mixed.json).toHaveBeenCalledWith({
      bookmarks: [availableBookmark],
      storageAvailable: true,
      skippedUnknownAgents: 1,
    });
  });

  it("stores only identity from current and legacy snapshot payloads", async () => {
    const current = makeContext({
      body: { reference: validReference, session: { stale: true }, bookmarkedAt: 99 },
    });
    await handlePutBookmark(current as never);

    const legacy = makeContext({ body: legacyBookmark });
    await handlePutBookmark(legacy as never);

    expect(coreMocks.upsertBookmark).toHaveBeenNthCalledWith(1, validReference);
    expect(coreMocks.upsertBookmark).toHaveBeenNthCalledWith(2, validReference);
    expect(current.json).toHaveBeenCalledWith({
      bookmark: storedBookmark,
      storageAvailable: true,
    });
  });

  it("maps bookmark write availability errors and rethrows unexpected failures", async () => {
    coreMocks.upsertBookmark.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext({ body: { reference: validReference } });
    await handlePutBookmark(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Bookmark storage is unavailable" },
      503,
    );

    coreMocks.upsertBookmark.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await expect(
      handlePutBookmark(makeContext({ body: { reference: validReference } }) as never),
    ).rejects.toThrow("unexpected");
  });

  it("validates, imports, and materializes bookmark fact batches", async () => {
    const nonArray = makeContext({ body: storedBookmark });
    await handleImportBookmarks(nonArray as never, bookmarkScanSource);
    expect(nonArray.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);

    const mixed = makeContext({ body: [storedBookmark, { invalid: true }] });
    await handleImportBookmarks(mixed as never, bookmarkScanSource);
    expect(mixed.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);

    const valid = makeContext({ body: [storedBookmark] });
    await handleImportBookmarks(valid as never, bookmarkScanSource);
    expect(coreMocks.importBookmarks).toHaveBeenCalledWith([storedBookmark]);
    expect(valid.json).toHaveBeenCalledWith({
      bookmarks: [availableBookmark],
      storageAvailable: true,
    });

    const legacy = makeContext({ body: [legacyBookmark] });
    await handleImportBookmarks(legacy as never, bookmarkScanSource);
    expect(coreMocks.importBookmarks).toHaveBeenLastCalledWith([storedBookmark]);
  });

  it("rejects invalid import timestamps", async () => {
    const context = makeContext({
      body: [{ reference: validReference, bookmarkedAt: "3" }],
    });

    await handleImportBookmarks(context as never, bookmarkScanSource);

    expect(context.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);
    expect(coreMocks.importBookmarks).not.toHaveBeenCalled();
  });

  it("maps bookmark import availability errors and rethrows unexpected failures", async () => {
    coreMocks.importBookmarks.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext({ body: [storedBookmark] });
    await handleImportBookmarks(unavailable as never, bookmarkScanSource);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Bookmark storage is unavailable" },
      503,
    );

    coreMocks.importBookmarks.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await expect(
      handleImportBookmarks(makeContext({ body: [storedBookmark] }) as never, bookmarkScanSource),
    ).rejects.toThrow("unexpected");
  });

  it("validates bookmark identifiers before deleting", () => {
    const missingAgent = makeContext({ param: { id: "s1" } });
    handleDeleteBookmark(missingAgent as never);
    expect(missingAgent.json).toHaveBeenCalledWith({ error: "Missing bookmark identifier" }, 400);

    const missingSession = makeContext({ param: { agent: "codex" } });
    handleDeleteBookmark(missingSession as never);
    expect(missingSession.json).toHaveBeenCalledWith({ error: "Missing bookmark identifier" }, 400);
    expect(coreMocks.deleteBookmark).not.toHaveBeenCalled();
  });

  it("deletes bookmarks and handles storage failures", () => {
    const valid = makeContext({ param: { agent: "codex", id: "s1" } });
    handleDeleteBookmark(valid as never);
    expect(coreMocks.deleteBookmark).toHaveBeenCalledWith({
      agentName: "codex",
      sessionId: "s1",
    });
    expect(valid.json).toHaveBeenCalledWith({ ok: true, storageAvailable: true });

    coreMocks.deleteBookmark.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext({ param: { agent: "codex", id: "s1" } });
    handleDeleteBookmark(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Bookmark storage is unavailable" },
      503,
    );

    coreMocks.deleteBookmark.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    expect(() =>
      handleDeleteBookmark(makeContext({ param: { agent: "codex", id: "s1" } }) as never),
    ).toThrow("unexpected");
  });
});

describe("session alias handlers", () => {
  it("validates alias payloads and identifiers", async () => {
    const missingAgent = makeContext({ body: { alias: "Renamed" }, param: { id: "s1" } });
    await handlePutSessionAlias(missingAgent as never);
    expect(missingAgent.json).toHaveBeenCalledWith({ error: "Invalid session alias payload" }, 400);

    const missingSession = makeContext({
      body: { alias: "Renamed" },
      param: { agent: "codex" },
    });
    await handlePutSessionAlias(missingSession as never);
    expect(missingSession.json).toHaveBeenCalledWith(
      { error: "Invalid session alias payload" },
      400,
    );

    const invalidAlias = makeContext({
      body: { alias: 42 },
      param: { agent: "codex", id: "s1" },
    });
    await handlePutSessionAlias(invalidAlias as never);
    expect(invalidAlias.json).toHaveBeenCalledWith({ error: "Invalid session alias payload" }, 400);
  });

  it("stores valid aliases and maps validation failures", async () => {
    const valid = makeContext({
      body: { alias: "Renamed" },
      param: { agent: "codex", id: "s1" },
    });
    await handlePutSessionAlias(valid as never);
    expect(coreMocks.upsertSessionAlias).toHaveBeenCalledWith(
      { agentName: "codex", sessionId: "s1" },
      "Renamed",
    );

    coreMocks.upsertSessionAlias.mockImplementationOnce(() => {
      throw new SessionAliasValidationError();
    });
    const invalid = makeContext({
      body: { alias: " " },
      param: { agent: "codex", id: "s1" },
    });
    await handlePutSessionAlias(invalid as never);
    expect(invalid.json).toHaveBeenCalledWith(
      { error: "Session alias must be non-empty and at most 160 characters" },
      400,
    );
  });

  it("lets internal TypeErrors reach the HTTP error boundary", async () => {
    coreMocks.upsertSessionAlias.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const app = createApiRoutes(scanSource);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await app.request("http://localhost/session-aliases/codex/s1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: "Renamed" }),
      });

      expect(response.status).toBe(500);
      expect(errorLog).toHaveBeenCalledWith(expect.any(TypeError));
    } finally {
      errorLog.mockRestore();
    }
  });

  it("maps unavailable alias storage and rethrows unexpected write failures", async () => {
    coreMocks.upsertSessionAlias.mockImplementationOnce(() => {
      throw new StateStorageUnavailableError();
    });
    const unavailable = makeContext({
      body: { alias: "Renamed" },
      param: { agent: "codex", id: "s1" },
    });
    await handlePutSessionAlias(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Session alias storage is unavailable" },
      503,
    );

    coreMocks.upsertSessionAlias.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await expect(
      handlePutSessionAlias(
        makeContext({
          body: { alias: "Renamed" },
          param: { agent: "codex", id: "s1" },
        }) as never,
      ),
    ).rejects.toThrow("unexpected");
  });

  it("validates alias identifiers before deleting", () => {
    const missingAgent = makeContext({ param: { id: "s1" } });
    handleDeleteSessionAlias(missingAgent as never);
    expect(missingAgent.json).toHaveBeenCalledWith(
      { error: "Missing session alias identifier" },
      400,
    );

    const missingSession = makeContext({ param: { agent: "codex" } });
    handleDeleteSessionAlias(missingSession as never);
    expect(missingSession.json).toHaveBeenCalledWith(
      { error: "Missing session alias identifier" },
      400,
    );
  });

  it("deletes aliases and handles storage failures", () => {
    const valid = makeContext({ param: { agent: "codex", id: "s1" } });
    handleDeleteSessionAlias(valid as never);
    expect(coreMocks.deleteSessionAlias).toHaveBeenCalledWith({
      agentName: "codex",
      sessionId: "s1",
    });
    expect(valid.json).toHaveBeenCalledWith({ ok: true });

    coreMocks.deleteSessionAlias.mockImplementationOnce(() => {
      throw new StateStorageUnavailableError();
    });
    const unavailable = makeContext({ param: { agent: "codex", id: "s1" } });
    handleDeleteSessionAlias(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Session alias storage is unavailable" },
      503,
    );

    coreMocks.deleteSessionAlias.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    expect(() =>
      handleDeleteSessionAlias(makeContext({ param: { agent: "codex", id: "s1" } }) as never),
    ).toThrow("unexpected");
  });
});
