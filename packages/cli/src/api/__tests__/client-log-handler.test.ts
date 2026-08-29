import { describe, expect, it } from "vitest";
import { loggerMocks, makeContext } from "./state-handler-test-fixtures.js";

const { handlePostClientLog } = await import("../client-log-handler.js");

describe("client logging handler", () => {
  it("rejects malformed, blank, and unknown log events", async () => {
    const malformed = makeContext({ rejectBody: true });
    await handlePostClientLog(malformed as never);
    expect(malformed.json).toHaveBeenCalledWith({ ok: false }, 400);

    const blank = makeContext({ body: { event: "   " } });
    await handlePostClientLog(blank as never);
    expect(blank.json).toHaveBeenCalledWith({ ok: false }, 400);

    const unknown = makeContext({ body: { event: "private arbitrary text" } });
    await handlePostClientLog(unknown as never);
    expect(unknown.json).toHaveBeenCalledWith({ ok: false }, 400);
    expect(loggerMocks.info).not.toHaveBeenCalled();
  });

  it("keeps only known low-risk scalar log data", async () => {
    const data = {
      agent: "codex",
      session: null,
      duration_ms: 42,
      error_name: "TypeError",
      error_status: 500,
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
      request_key: "x".repeat(400),
      error: "/Users/private/session.jsonl",
      path: "/Users/private",
      detail: { prompt: "private prompt" },
      nested: { value: 1 },
      enabled: true,
    };
    const c = makeContext({
      body: { event: " session.open.error ", data },
    });

    await handlePostClientLog(c as never);

    const [event, loggedData] = loggerMocks.info.mock.calls[0]!;
    expect(event).toBe("client.session.open.error");
    expect(loggedData).toEqual({
      agent: "codex",
      session: null,
      duration_ms: 42,
      error_name: "TypeError",
      error_status: 500,
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
      request_key: "x".repeat(300),
    });
    expect(JSON.stringify(loggedData)).not.toContain("private");
    expect(c.json).toHaveBeenCalledWith({ ok: true });
  });

  it("drops invalid values for allowed fields", async () => {
    const c = makeContext({
      body: {
        event: "app.load.done",
        data: {
          agent: { name: "codex" },
          duration_ms: Number.POSITIVE_INFINITY,
          messages: -1,
          error_status: "500",
          operation_id: "123e4567-e89b-02d3-7456-426614174000",
        },
      },
    });

    await handlePostClientLog(c as never);

    expect(loggerMocks.info).toHaveBeenCalledWith("client.app.load.done", {});
  });

  it("drops non-record log data", async () => {
    const c = makeContext({ body: { event: "app.load.start", data: "not-an-object" } });

    await handlePostClientLog(c as never);

    expect(loggerMocks.info).toHaveBeenCalledWith("client.app.load.start", {});
  });
});
