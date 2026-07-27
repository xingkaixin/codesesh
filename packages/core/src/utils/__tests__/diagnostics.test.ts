import { afterEach, describe, expect, it } from "vitest";
import { getCoreDiagnostics, setCoreDiagnostics, type CoreDiagnostics } from "../diagnostics.js";

afterEach(() => {
  setCoreDiagnostics(null);
});

describe("core diagnostics", () => {
  it("defaults to no injected sink", () => {
    expect(getCoreDiagnostics()).toBeNull();
  });

  it("returns a sink that forwards to the injected one until reset", () => {
    const calls: Array<{
      level: "info" | "warn";
      event: string;
      detail?: Record<string, unknown>;
    }> = [];
    const sink: CoreDiagnostics = {
      info: (event, detail) => calls.push({ level: "info", event, detail }),
      warn: (event, detail) => calls.push({ level: "warn", event, detail }),
    };
    setCoreDiagnostics(sink);

    getCoreDiagnostics()?.info?.("test.started", { version: 1 });
    getCoreDiagnostics()?.warn("test.event", { a: 1 });
    expect(calls).toEqual([
      { level: "info", event: "test.started", detail: { version: 1 } },
      { level: "warn", event: "test.event", detail: { a: 1 } },
    ]);

    setCoreDiagnostics(null);
    expect(getCoreDiagnostics()).toBeNull();
  });

  it("swallows exceptions thrown by an injected sink", () => {
    const sink: CoreDiagnostics = {
      info: () => {
        throw new Error("sink boom");
      },
      warn: () => {
        throw new Error("sink boom");
      },
    };
    setCoreDiagnostics(sink);

    expect(() => getCoreDiagnostics()?.info?.("test.event")).not.toThrow();
    expect(() => getCoreDiagnostics()?.warn("test.event")).not.toThrow();
  });
});
