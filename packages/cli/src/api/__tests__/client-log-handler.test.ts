import { describe, expect, it } from "vitest";
import { loggerMocks, makeContext } from "./state-handler-test-fixtures.js";

const { handlePostClientLog } = await import("../client-log-handler.js");

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
