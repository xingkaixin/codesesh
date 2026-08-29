import { describe, expect, it, vi } from "vitest";
import { addCalendarDays } from "@codesesh/core/contract";
import {
  coreMocks,
  getResponsePayload,
  loggerMocks,
  makeContext,
  makeProjectIdentityResolver,
  scanSource,
} from "./state-handler-test-fixtures.js";

const { handleGetAgents, handleGetProjects } = await import("../catalog-handlers.js");
const { handleGetDashboard } = await import("../dashboard-handler.js");
const { handleGetFileActivity, handleSearchSessions } = await import("../search-handlers.js");
const { handleGetSessions } = await import("../session-handlers.js");

describe("query boundary handlers", () => {
  const dateHandlers: Array<{
    endpoint: string;
    invoke: (context: ReturnType<typeof makeContext>) => unknown;
  }> = [
    { endpoint: "agents", invoke: (context) => handleGetAgents(context as never, scanSource) },
    { endpoint: "projects", invoke: (context) => handleGetProjects(context as never, scanSource) },
    { endpoint: "sessions", invoke: (context) => handleGetSessions(context as never, scanSource) },
    { endpoint: "search", invoke: (context) => handleSearchSessions(context as never, scanSource) },
    { endpoint: "file-activity", invoke: (context) => handleGetFileActivity(context as never) },
    {
      endpoint: "dashboard",
      invoke: (context) => handleGetDashboard(context as never, scanSource),
    },
  ];

  for (const { endpoint, invoke } of dateHandlers) {
    for (const parameter of ["from", "to"] as const) {
      it(`rejects an invalid ${parameter} parameter on ${endpoint}`, () => {
        const context = makeContext({ query: { [parameter]: "not-a-date" } });

        invoke(context);

        expect(context.json).toHaveBeenCalledWith(
          { error: `${parameter} must be a valid date` },
          400,
        );
        expect(loggerMocks.warn).toHaveBeenCalledWith("api.query_parameter.invalid", {
          endpoint,
          parameter,
          validation_outcome: "rejected",
        });
      });
    }
  }

  it("reports rejected and empty-result parameter outcomes", () => {
    const sessions = makeContext({ query: { agent: "nonexistent" } });
    handleGetSessions(sessions as never, scanSource);
    const files = makeContext({ query: { limit: "1.5" } });
    handleGetFileActivity(files as never);

    expect(loggerMocks.warn).toHaveBeenCalledWith("api.query_parameter.invalid", {
      endpoint: "sessions",
      parameter: "agent",
      validation_outcome: "empty_result",
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith("api.query_parameter.invalid", {
      endpoint: "file-activity",
      parameter: "limit",
      validation_outcome: "rejected",
    });
    expect(files.json).toHaveBeenCalledWith({ error: "limit must be a positive integer" }, 400);
    expect(coreMocks.listFileActivity).not.toHaveBeenCalled();
  });

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

  it("normalizes file activity filters and caps the result limit", async () => {
    const c = makeContext({
      query: {
        agent: " CoDeX ",
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

    const resolver = makeProjectIdentityResolver();
    await handleGetFileActivity(c as never, {}, resolver);

    expect(coreMocks.listFileActivity).toHaveBeenCalledWith({
      agent: "codex",
      sessionId: "s1",
      projectKind: "path",
      projectKey: "/repo",
      project: "repo",
      projectScope: {
        identity: { kind: "path", key: "/repo" },
        path: "/repo",
      },
      path: "src/index.ts",
      kind: "edit",
      from: new Date("2026-01-01T00:00:00.000Z").getTime(),
      to: new Date("2026-01-02T00:00:00.000Z").getTime(),
      limit: 200,
    });
    expect(resolver.resolve).toHaveBeenCalledWith("/repo", expect.any(AbortSignal));
  });

  it.each(["1.5", "0", "-1", "", "Infinity", "invalid"])(
    "rejects invalid file activity limit %j before storage",
    (limit) => {
      const c = makeContext({ query: { kind: "execute", limit } });

      handleGetFileActivity(c as never);

      expect(c.json).toHaveBeenCalledWith({ error: "limit must be a positive integer" }, 400);
      expect(coreMocks.listFileActivity).not.toHaveBeenCalled();
    },
  );

  it("returns an empty file activity result for an unknown agent without querying storage", () => {
    const c = makeContext({ query: { agent: "nonexistent" } });

    handleGetFileActivity(c as never);

    expect(c.json).toHaveBeenCalledWith({ activity: [] });
    expect(coreMocks.listFileActivity).not.toHaveBeenCalled();
  });

  // `days` is the number of calendar days covered, so it matches the bucket count.
  it("derives dashboard days from custom and default windows", () => {
    const custom = makeContext({
      query: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-03T00:00:00.000Z",
        days: "1",
      },
    });
    handleGetDashboard(custom as never, scanSource);
    const customFrom = new Date("2026-01-01T00:00:00.000Z").getTime();
    expect(getResponsePayload<{ window: unknown }>(custom).window).toEqual({
      from: customFrom,
      to: new Date("2026-01-03T00:00:00.000Z").getTime(),
      days: 3,
      compareFrom: addCalendarDays(customFrom, -3),
      compareTo: customFrom - 1,
    });

    const fallback = makeContext({ query: { to: "2026-01-04T00:00:00.000Z" } });
    handleGetDashboard(fallback as never, scanSource, {
      from: new Date("2026-01-01T00:00:00.000Z").getTime(),
    });
    expect(getResponsePayload<{ window: { days: number } }>(fallback).window.days).toBe(4);
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
