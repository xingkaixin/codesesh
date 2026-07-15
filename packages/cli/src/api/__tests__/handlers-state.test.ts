import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  deleteBookmark: vi.fn(),
  deleteSessionAlias: vi.fn(),
  importBookmarks: vi.fn(),
  listBookmarks: vi.fn(),
  listFileActivity: vi.fn(),
  listSessionAliases: vi.fn(),
  upsertBookmark: vi.fn(),
  upsertSessionAlias: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@codesesh/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core")>();
  return {
    ...actual,
    deleteBookmark: coreMocks.deleteBookmark,
    deleteSessionAlias: coreMocks.deleteSessionAlias,
    importBookmarks: coreMocks.importBookmarks,
    listBookmarks: coreMocks.listBookmarks,
    listFileActivity: coreMocks.listFileActivity,
    listSessionAliases: coreMocks.listSessionAliases,
    upsertBookmark: coreMocks.upsertBookmark,
    upsertSessionAlias: coreMocks.upsertSessionAlias,
  };
});

vi.mock("../../logging.js", () => ({ appLogger: loggerMocks }));

import {
  BookmarkStorageUnavailableError,
  StateStorageUnavailableError,
  type BookmarkRecord,
  type ScanResult,
} from "@codesesh/core";
import {
  handleDeleteBookmark,
  handleDeleteSessionAlias,
  handleGetBookmarks,
  handleGetDashboard,
  handleGetFileActivity,
  handleGetSessions,
  handleImportBookmarks,
  handlePostClientLog,
  handlePutBookmark,
  handlePutSessionAlias,
  type ScanResultSource,
} from "../handlers.js";

interface ContextOptions {
  body?: unknown;
  rejectBody?: boolean;
  param?: Record<string, string>;
  query?: Record<string, string>;
}

function makeContext(options: ContextOptions = {}) {
  const params = new URLSearchParams(options.query ?? {});
  return {
    req: {
      json: () =>
        options.rejectBody
          ? Promise.reject(new SyntaxError("invalid JSON"))
          : Promise.resolve(options.body),
      param: (key: string) => options.param?.[key],
      query: (key: string) => options.query?.[key],
      url: `http://localhost/${params.size > 0 ? `?${params.toString()}` : ""}`,
    },
    json: vi.fn((payload: unknown, status = 200) => ({ payload, status })),
  };
}

function getResponsePayload<T>(context: ReturnType<typeof makeContext>): T {
  return context.json.mock.calls[0]![0] as T;
}

const validBookmark: Omit<BookmarkRecord, "bookmarked_at"> = {
  agentKey: "codex",
  sessionId: "s1",
  fullPath: "codex/s1",
  title: "Session one",
  directory: "/workspace",
  time_created: 1,
  time_updated: 2,
  stats: {
    message_count: 1,
    total_input_tokens: 2,
    total_output_tokens: 3,
    total_cost: 0.1,
    total_tokens: 5,
  },
};

const storedBookmark: BookmarkRecord = {
  ...validBookmark,
  bookmarked_at: 3,
};

const scanSource: ScanResultSource = {
  getSnapshot: () =>
    ({
      sessions: [],
      byAgent: {},
      agents: [],
    }) as ScanResult,
};

beforeEach(() => {
  vi.resetAllMocks();
  coreMocks.listBookmarks.mockReturnValue([]);
  coreMocks.listFileActivity.mockReturnValue([]);
  coreMocks.listSessionAliases.mockReturnValue([]);
  coreMocks.upsertBookmark.mockReturnValue(storedBookmark);
  coreMocks.importBookmarks.mockReturnValue([storedBookmark]);
  coreMocks.upsertSessionAlias.mockReturnValue({
    agentKey: "codex",
    sessionId: "s1",
    alias: "Renamed",
    updated_at: 1,
  });
});

afterEach(() => vi.useRealTimers());

describe("client logging handler", () => {
  it("rejects malformed and blank log events", async () => {
    const malformed = makeContext({ rejectBody: true });
    await handlePostClientLog(malformed as never);
    expect(malformed.json).toHaveBeenCalledWith({ ok: false }, 400);

    const blank = makeContext({ body: { event: "   " } });
    await handlePostClientLog(blank as never);
    expect(blank.json).toHaveBeenCalledWith({ ok: false }, 400);
    expect(loggerMocks.info).not.toHaveBeenCalled();
  });

  it("sanitizes event names and bounds structured log data", async () => {
    const data = {
      text: "x".repeat(400),
      count: 2,
      enabled: true,
      empty: null,
      nested: { value: 1 },
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`extra${index}`, index])),
    };
    const c = makeContext({
      body: { event: ` feature launch!?${"z".repeat(140)}`, data },
    });

    await handlePostClientLog(c as never);

    const [event, loggedData] = loggerMocks.info.mock.calls[0]!;
    expect(event).toMatch(/^client\.feature_launch__/);
    expect(event).toHaveLength(127);
    expect(loggedData).toMatchObject({
      text: "x".repeat(300),
      count: 2,
      enabled: true,
      empty: null,
      nested: "[object Object]",
    });
    expect(Object.keys(loggedData)).toHaveLength(30);
    expect(c.json).toHaveBeenCalledWith({ ok: true });
  });

  it("drops non-record log data", async () => {
    const c = makeContext({ body: { event: "ready", data: "not-an-object" } });

    await handlePostClientLog(c as never);

    expect(loggerMocks.info).toHaveBeenCalledWith("client.ready", {});
  });
});

describe("bookmark handlers", () => {
  it("projects aliases onto stored bookmark snapshots", () => {
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    coreMocks.listSessionAliases.mockReturnValue([
      { agentKey: "codex", sessionId: "s1", alias: "Renamed", updated_at: 1 },
    ]);
    const c = makeContext();

    handleGetBookmarks(c as never);

    expect(c.json).toHaveBeenCalledWith({
      bookmarks: [{ ...storedBookmark, display_title: "Renamed" }],
      storageAvailable: true,
    });
  });

  it("tolerates unavailable alias storage and logs unexpected alias failures", () => {
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw new StateStorageUnavailableError();
    });
    handleGetBookmarks(makeContext() as never);
    expect(loggerMocks.warn).not.toHaveBeenCalled();

    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw new Error("corrupt aliases");
    });
    handleGetBookmarks(makeContext() as never);
    expect(loggerMocks.warn).toHaveBeenLastCalledWith("api.session_aliases.load_failed", {
      error: "corrupt aliases",
    });

    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw "invalid aliases";
    });
    handleGetBookmarks(makeContext() as never);
    expect(loggerMocks.warn).toHaveBeenLastCalledWith("api.session_aliases.load_failed", {
      error: "invalid aliases",
    });
  });

  it("reports unavailable bookmark storage and rethrows unexpected failures", () => {
    coreMocks.listBookmarks.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext();
    handleGetBookmarks(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith({ bookmarks: [], storageAvailable: false });

    coreMocks.listBookmarks.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    expect(() => handleGetBookmarks(makeContext() as never)).toThrow("unexpected");
  });

  it.each([
    null,
    {},
    { ...validBookmark, agentKey: 1 },
    { ...validBookmark, sessionId: 1 },
    { ...validBookmark, fullPath: 1 },
    { ...validBookmark, title: 1 },
    { ...validBookmark, directory: 1 },
    { ...validBookmark, time_created: "1" },
    { ...validBookmark, time_updated: "2" },
    { ...validBookmark, stats: null },
    { ...validBookmark, stats: { ...validBookmark.stats, message_count: "1" } },
    { ...validBookmark, stats: { ...validBookmark.stats, total_input_tokens: "2" } },
    { ...validBookmark, stats: { ...validBookmark.stats, total_output_tokens: "3" } },
    { ...validBookmark, stats: { ...validBookmark.stats, total_cost: "0.1" } },
    { ...validBookmark, stats: { ...validBookmark.stats, total_tokens: "5" } },
  ])("rejects invalid bookmark payload %#", async (body) => {
    const c = makeContext({ body });

    await handlePutBookmark(c as never);

    expect(c.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);
    expect(coreMocks.upsertBookmark).not.toHaveBeenCalled();
  });

  it("stores valid bookmarks without transport-only fields", async () => {
    const c = makeContext({ body: { ...validBookmark, bookmarked_at: 99 } });

    await handlePutBookmark(c as never);

    expect(coreMocks.upsertBookmark).toHaveBeenCalledWith(validBookmark);
    expect(c.json).toHaveBeenCalledWith({ bookmark: storedBookmark, storageAvailable: true });
  });

  it("maps bookmark write availability errors and rethrows unexpected failures", async () => {
    coreMocks.upsertBookmark.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext({ body: validBookmark });
    await handlePutBookmark(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Bookmark storage is unavailable" },
      503,
    );

    coreMocks.upsertBookmark.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await expect(handlePutBookmark(makeContext({ body: validBookmark }) as never)).rejects.toThrow(
      "unexpected",
    );
  });

  it("validates and imports bookmark batches", async () => {
    const nonArray = makeContext({ body: validBookmark });
    await handleImportBookmarks(nonArray as never);
    expect(nonArray.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);

    const mixed = makeContext({ body: [validBookmark, { invalid: true }] });
    await handleImportBookmarks(mixed as never);
    expect(mixed.json).toHaveBeenCalledWith({ error: "Invalid bookmark payload" }, 400);

    const valid = makeContext({ body: [validBookmark] });
    await handleImportBookmarks(valid as never);
    expect(coreMocks.importBookmarks).toHaveBeenCalledWith([validBookmark]);
    expect(valid.json).toHaveBeenCalledWith({
      bookmarks: [storedBookmark],
      storageAvailable: true,
    });
  });

  it("maps bookmark import availability errors and rethrows unexpected failures", async () => {
    coreMocks.importBookmarks.mockImplementationOnce(() => {
      throw new BookmarkStorageUnavailableError();
    });
    const unavailable = makeContext({ body: [validBookmark] });
    await handleImportBookmarks(unavailable as never);
    expect(unavailable.json).toHaveBeenCalledWith(
      { error: "Bookmark storage is unavailable" },
      503,
    );

    coreMocks.importBookmarks.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await expect(
      handleImportBookmarks(makeContext({ body: [validBookmark] }) as never),
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
    expect(coreMocks.deleteBookmark).toHaveBeenCalledWith("codex", "s1");
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
    expect(coreMocks.upsertSessionAlias).toHaveBeenCalledWith("codex", "s1", "Renamed");

    coreMocks.upsertSessionAlias.mockImplementationOnce(() => {
      throw new TypeError("invalid alias");
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
    expect(coreMocks.deleteSessionAlias).toHaveBeenCalledWith("codex", "s1");
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

describe("query boundary handlers", () => {
  it("rejects invalid project identities consistently", () => {
    const sessions = makeContext({ query: { projectKind: "path" } });
    handleGetSessions(sessions as never, scanSource);
    expect(sessions.json).toHaveBeenCalledWith(
      { error: "projectKind and projectKey must form a valid project identity" },
      400,
    );

    const files = makeContext({ query: { projectKind: "invalid", projectKey: "/repo" } });
    handleGetFileActivity(files as never);
    expect(files.json).toHaveBeenCalledWith(
      { error: "projectKind and projectKey must form a valid project identity" },
      400,
    );

    const dashboard = makeContext({ query: { projectKey: "/repo" } });
    handleGetDashboard(dashboard as never, scanSource);
    expect(dashboard.json).toHaveBeenCalledWith(
      { error: "projectKind and projectKey must form a valid project identity" },
      400,
    );
  });

  it("normalizes file activity filters and caps the result limit", () => {
    const c = makeContext({
      query: {
        agent: " codex ",
        sessionId: " s1 ",
        projectKind: "path",
        projectKey: "/repo",
        project: " repo ",
        cwd: " /repo ",
        path: " src/index.ts ",
        kind: "edit",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
        limit: "999",
      },
    });

    handleGetFileActivity(c as never);

    expect(coreMocks.listFileActivity).toHaveBeenCalledWith({
      agent: "codex",
      sessionId: "s1",
      projectKind: "path",
      projectKey: "/repo",
      project: "repo",
      cwd: "/repo",
      path: "src/index.ts",
      kind: "edit",
      from: new Date("2026-01-01T00:00:00.000Z").getTime(),
      to: new Date("2026-01-02T00:00:00.000Z").getTime(),
      limit: 200,
    });
  });

  it("uses safe defaults for invalid file activity filters", () => {
    const c = makeContext({ query: { kind: "execute", limit: "invalid" } });

    handleGetFileActivity(c as never);

    expect(coreMocks.listFileActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: undefined, limit: 50 }),
    );
  });

  it("derives dashboard days from custom and default windows", () => {
    const custom = makeContext({
      query: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-03T00:00:00.000Z",
      },
    });
    handleGetDashboard(custom as never, scanSource);
    expect(getResponsePayload<{ window: unknown }>(custom).window).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z").getTime(),
      to: new Date("2026-01-03T00:00:00.000Z").getTime(),
      days: 2,
    });

    const fallback = makeContext({ query: { to: "2026-01-04T00:00:00.000Z" } });
    handleGetDashboard(fallback as never, scanSource, {
      from: new Date("2026-01-01T00:00:00.000Z").getTime(),
    });
    expect(getResponsePayload<{ window: { days: number } }>(fallback).window.days).toBe(3);
  });

  it("supports explicit all-time dashboard queries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    const c = makeContext({ query: { days: "0" } });

    handleGetDashboard(c as never, scanSource);

    expect(getResponsePayload<{ window: unknown }>(c).window).toEqual({
      from: undefined,
      to: Date.now(),
      days: 0,
    });
  });
});
