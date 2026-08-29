import { describe, expect, it } from "vitest";
import { LogRecordEncoder } from "./log-record.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function createEncoder(): LogRecordEncoder {
  return new LogRecordEncoder({
    fingerprintKey: Buffer.alloc(32, 1),
    maxRecordBytes: 64 * 1_024,
  });
}

function encode(data: Record<string, unknown>, event = "test.event"): Record<string, unknown> {
  return JSON.parse(
    createEncoder().encode({
      timestamp: "2026-08-30T00:00:00.000Z",
      level: "info",
      event,
      runId: UUID,
      sequence: 1,
      pid: 1,
      data,
    }).line,
  ) as Record<string, unknown>;
}

describe("LogRecordEncoder", () => {
  it("fingerprints unapproved strings and identifiers while preserving audited values", () => {
    const record = encode({
      detail: "private detail",
      unsafe: {
        source: "private-source",
        trigger: "private-trigger",
        reason: "private-reason",
      },
      profiler_id: "private-profiler",
      error_name: "PrivateError",
      userId: "12345",
      count: 12,
      enabled: true,
      empty: null,
      agent: "codex",
      method: "POST",
      browser: {
        mode: "session",
        phase: "mount",
        profiler_id: "App",
        source: "react-profiler",
        trigger: "route",
        reason: "query-cancelled",
      },
      sync: { mode: "bulk", failed_agents: ["codex", "private-agent"] },
      exception_origin: "uncaughtException",
      context: "scan.refresh",
      route: "/api/sessions/:agent/:id",
      status: "committed",
    });

    expect(record.detail).toMatch(/^string:[a-f0-9]{16}$/);
    expect(record.unsafe).toMatchObject({
      source: expect.stringMatching(/^string:[a-f0-9]{16}$/),
      trigger: expect.stringMatching(/^string:[a-f0-9]{16}$/),
      reason: expect.stringMatching(/^string:[a-f0-9]{16}$/),
    });
    expect(record.profiler_id).toMatch(/^identifier:[a-f0-9]{16}$/);
    expect(record.error_name).toMatch(/^string:[a-f0-9]{16}$/);
    expect(record.userId).toMatch(/^identifier:[a-f0-9]{16}$/);
    expect(record).toMatchObject({
      count: 12,
      enabled: true,
      empty: null,
      agent: "codex",
      method: "POST",
      browser: {
        mode: "session",
        phase: "mount",
        profiler_id: "App",
        source: "react-profiler",
        trigger: "route",
        reason: "query-cancelled",
      },
      sync: {
        mode: "bulk",
        failed_agents: ["codex", expect.stringMatching(/^string:[a-f0-9]{16}$/)],
      },
      exception_origin: "uncaughtException",
      context: "scan.refresh",
      route: "/api/sessions/:agent/:id",
      status: "committed",
    });
  });

  it("only preserves browser correlation identifiers when they are UUIDs", () => {
    const record = encode(
      {
        valid_operation_id: UUID,
        operation_id: UUID,
        request_id: "private-request",
        connection_id: "private-connection",
        context: "private-context",
        status: "private-status",
      },
      "client.session.open",
    );

    expect(record.valid_operation_id).toMatch(/^identifier:[a-f0-9]{16}$/);
    expect(record.operation_id).toBe(UUID);
    expect(record.request_id).toMatch(/^identifier:[a-f0-9]{16}$/);
    expect(record.connection_id).toMatch(/^identifier:[a-f0-9]{16}$/);
    expect(record.context).toMatch(/^string:[a-f0-9]{16}$/);
    expect(record.status).toMatch(/^string:[a-f0-9]{16}$/);

    expect(
      encode({ request_id: "internal-request", operation_id: "internal-operation" }),
    ).toMatchObject({ request_id: "internal-request", operation_id: "internal-operation" });
  });

  it("keeps sanitized stack frames through a second pass", () => {
    const encoder = createEncoder();
    const error = new Error("private failure");
    Object.defineProperty(error, "stack", {
      value: "Error: private failure\n    at first (first.ts:1:1)\n    at second (second.ts:2:2)",
    });
    const transported = encoder.sanitizeForTransport({ error }, "worker.failed");
    const record = JSON.parse(
      encoder.encode({
        timestamp: "2026-08-30T00:00:00.000Z",
        level: "error",
        event: "worker.failed",
        runId: UUID,
        sequence: 1,
        pid: 1,
        data: transported,
      }).line,
    ) as { error: { stack: string } };

    expect(record.error.stack).toContain("at first");
    expect(record.error.stack).toContain("at second");
    expect(record.error.stack).not.toContain("private failure");
    expect(encode({ stack: "    at only (single.ts:1:1)" }).stack).toContain("at only");
  });

  it("rejects proxies without invoking their traps", () => {
    let ownKeysCalls = 0;
    const value = new Proxy(
      {},
      {
        ownKeys() {
          ownKeysCalls += 1;
          throw new Error("must not run");
        },
      },
    );

    expect(encode({ value }).value).toBe("[unserializable]");
    expect(ownKeysCalls).toBe(0);

    let conversionCalls = 0;
    const callable = new Proxy(() => undefined, {
      get() {
        conversionCalls += 1;
        throw new Error("must not run");
      },
    });
    expect(encode({ callable }).callable).toBe("[unserializable]");
    expect(conversionCalls).toBe(0);

    let prototypeCalls = 0;
    const prototype = new Proxy(
      {},
      {
        getPrototypeOf() {
          prototypeCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    expect(encode({ inherited: Object.create(prototype) }).inherited).toEqual({});
    expect(prototypeCalls).toBe(0);
  });

  it("reads errors and arrays without invoking accessors and detects error cycles", () => {
    let accessorCalls = 0;
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        accessorCalls += 1;
        return "private message";
      },
    });
    Object.defineProperty(error, "cause", { value: error });
    const unsafeString = {
      toString() {
        accessorCalls += 1;
        return "private value";
      },
    };
    Object.defineProperty(error, "name", { value: unsafeString });
    Object.defineProperty(error, "stack", { value: unsafeString });
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "private value";
      },
    });
    values.length = 1;

    const record = encode({ error, values }) as {
      error: { cause: string };
      values: unknown[];
    };
    expect(record.error.cause).toBe("[circular]");
    expect(record.values).toEqual(["[accessor]"]);
    expect(accessorCalls).toBe(0);
  });

  it("uses built-in container methods and omits binary views", () => {
    let overriddenCalls = 0;
    const map = new Map([["key", "value"]]);
    const set = new Set(["value"]);
    const date = new Date("2026-08-30T00:00:00.000Z");
    const url = new URL("https://example.com/private?token=secret");
    const binary = new Uint8Array([1, 2, 3]);
    for (const [target, key] of [
      [map, "entries"],
      [set, "values"],
      [date, "toISOString"],
      [date, "getTime"],
      [url, "toString"],
      [binary, "private"],
    ] as const) {
      Object.defineProperty(target, key, {
        configurable: true,
        get() {
          overriddenCalls += 1;
          throw new Error("must not run");
        },
      });
    }

    const record = encode({ map, set, date, url, binary });
    expect(record.map).toHaveLength(1);
    expect(record.set).toHaveLength(1);
    expect(record.date).toBe("2026-08-30T00:00:00.000Z");
    expect(record.url).toBe("https://example.com/");
    expect(record.binary).toBe("[omitted]");
    expect(overriddenCalls).toBe(0);
  });
});
