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
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    getCoreDiagnostics()?.warn("test.event", { a: 1 });
    expect(calls).toEqual([{ event: "test.event", detail: { a: 1 } }]);

    setCoreDiagnostics(null);
    expect(getCoreDiagnostics()).toBeNull();
  });

  it("swallows exceptions thrown by an injected sink", () => {
    const sink: CoreDiagnostics = {
      warn: () => {
        throw new Error("sink boom");
      },
    };
    setCoreDiagnostics(sink);

    expect(() => getCoreDiagnostics()?.warn("test.event")).not.toThrow();
  });
});
