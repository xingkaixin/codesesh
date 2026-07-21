import { afterEach, describe, expect, it } from "vitest";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  narrowField,
  reportFieldMismatch,
  safeParseJsonRecord,
} from "../narrow.js";
import { getCoreDiagnostics, setCoreDiagnostics, type CoreDiagnostics } from "../diagnostics.js";

afterEach(() => {
  setCoreDiagnostics(null);
});

describe("asRecord", () => {
  it("narrows plain objects", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("rejects null, arrays, and primitives", () => {
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord([1, 2])).toBeUndefined();
    expect(asRecord("record")).toBeUndefined();
    expect(asRecord(1)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
  });
});

describe("asString", () => {
  it("narrows strings, including empty ones", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("")).toBe("");
  });

  it("rejects non-strings", () => {
    expect(asString(1)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString({})).toBeUndefined();
  });
});

describe("asNumber", () => {
  it("narrows finite numbers, including zero", () => {
    expect(asNumber(42)).toBe(42);
    expect(asNumber(0)).toBe(0);
    expect(asNumber(-3.5)).toBe(-3.5);
  });

  it("rejects NaN, Infinity, and non-numbers", () => {
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asNumber("1")).toBeUndefined();
    expect(asNumber(null)).toBeUndefined();
    expect(asNumber(undefined)).toBeUndefined();
  });
});

describe("asArray", () => {
  it("narrows arrays, including empty ones", () => {
    expect(asArray([1, 2, 3])).toEqual([1, 2, 3]);
    expect(asArray([])).toEqual([]);
  });

  it("rejects non-arrays", () => {
    expect(asArray({ length: 0 })).toBeUndefined();
    expect(asArray("array")).toBeUndefined();
    expect(asArray(null)).toBeUndefined();
    expect(asArray(undefined)).toBeUndefined();
  });
});

describe("reportFieldMismatch", () => {
  it("forwards agentName and field to the diagnostics sink", () => {
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    reportFieldMismatch("cursor", "usage.tokens");

    expect(calls).toEqual([
      {
        event: "agent.field_shape_mismatch",
        detail: { agentName: "cursor", field: "usage.tokens" },
      },
    ]);
  });

  it("dedupes repeated reports for the same agent+field", () => {
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    reportFieldMismatch("kimi", "message.role");
    reportFieldMismatch("kimi", "message.role");
    reportFieldMismatch("kimi", "message.role");

    expect(calls).toHaveLength(1);
  });

  it("reports distinct field keys for the same agent separately", () => {
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    reportFieldMismatch("codex", "usage.input_tokens");
    reportFieldMismatch("codex", "usage.output_tokens");

    expect(calls).toHaveLength(2);
  });

  it("is a no-op when no diagnostics sink is injected", () => {
    expect(getCoreDiagnostics()).toBeNull();
    expect(() => reportFieldMismatch("pi", "unset-sink-field")).not.toThrow();
  });
});

describe("narrowField", () => {
  it("returns the narrowed value on success", () => {
    expect(narrowField("test-agent", "field.string", "hello", asString)).toBe("hello");
    expect(narrowField("test-agent", "field.number", 42, asNumber)).toBe(42);
  });

  it("returns undefined silently for undefined and null (null-as-absent)", () => {
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    expect(narrowField("test-agent", "field.absent", undefined, asString)).toBeUndefined();
    expect(narrowField("test-agent", "field.null", null, asString)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("reports once when the field is present but narrowing fails", () => {
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    expect(narrowField("test-agent", "field.mismatch", 123, asString)).toBeUndefined();
    expect(narrowField("test-agent", "field.mismatch", 123, asString)).toBeUndefined();

    expect(calls).toEqual([
      {
        event: "agent.field_shape_mismatch",
        detail: { agentName: "test-agent", field: "field.mismatch" },
      },
    ]);
  });
});

describe("safeParseJsonRecord", () => {
  it("parses valid JSON objects", () => {
    expect(safeParseJsonRecord('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns undefined for malformed JSON without throwing", () => {
    expect(() => safeParseJsonRecord("{not json")).not.toThrow();
    expect(safeParseJsonRecord("{not json")).toBeUndefined();
  });

  it("returns undefined for valid JSON that isn't an object (array, null, primitive)", () => {
    expect(safeParseJsonRecord("[1,2]")).toBeUndefined();
    expect(safeParseJsonRecord("null")).toBeUndefined();
    expect(safeParseJsonRecord('"text"')).toBeUndefined();
  });
});
