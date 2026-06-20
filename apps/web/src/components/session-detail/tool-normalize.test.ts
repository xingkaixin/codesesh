import { describe, expect, it } from "vitest";
import type { MessagePart } from "../../lib/api";
import {
  cleanToolTitle,
  extractCommand,
  extractToolTextSegments,
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  joinToolText,
  normalizeEscapedNewlines,
  normalizeToolLabel,
  normalizeToolName,
  stripSystemTag,
  toDisplayText,
  type NormalizedToolState,
} from "./tool-normalize";
import { escapeRegExp, parseInputCandidate, parseJsonText, toRecord } from "./utils";

function part(overrides?: Partial<MessagePart>): MessagePart {
  return { role: "tool", tool: "Read", title: "Read", ...overrides } as MessagePart;
}

describe("utils", () => {
  it("escapeRegExp escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });

  it("parseInputCandidate parses JSON strings", () => {
    expect(parseInputCandidate('{"a":1}')).toEqual({ a: 1 });
    expect(parseInputCandidate("plain")).toBe("plain");
    expect(parseInputCandidate(42)).toBe(42);
  });

  it("parseJsonText returns null on invalid JSON", () => {
    expect(parseJsonText("{bad}")).toBeNull();
    expect(parseJsonText('{"ok":true}')).toEqual({ ok: true });
  });

  it("toRecord coerces non-objects to empty object", () => {
    expect(toRecord(null)).toEqual({});
    expect(toRecord([1, 2])).toEqual({});
    expect(toRecord({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("toDisplayText", () => {
  it("returns empty string for null/undefined", () => {
    expect(toDisplayText(null)).toBe("");
    expect(toDisplayText(undefined)).toBe("");
  });

  it("pretty-prints JSON-looking strings", () => {
    expect(toDisplayText('{"b":2,"a":1}')).toBe('{\n  "b": 2,\n  "a": 1\n}');
  });

  it("serializes objects", () => {
    expect(toDisplayText({ x: 1 })).toBe('{\n  "x": 1\n}');
  });
});

describe("joinToolText / extractToolTextSegments / stripSystemTag", () => {
  it("extracts text segments recursively", () => {
    expect(extractToolTextSegments("hello")).toEqual(["hello"]);
    expect(extractToolTextSegments([{ text: "a" }, { text: "b" }])).toEqual(["a", "b"]);
    expect(extractToolTextSegments({ content: "nested" })).toEqual(["nested"]);
  });

  it("joinToolText joins segments", () => {
    expect(joinToolText([{ text: "a" }, { text: "b" }])).toBe("a\nb");
  });

  it("joinToolText strips system tags when includeSystem=false", () => {
    const result = joinToolText(["<system>hidden</system>", "visible"], false);
    expect(result).toBe("visible");
  });

  it("stripSystemTag removes system wrappers", () => {
    expect(stripSystemTag("<system>secret</system>")).toBe("secret");
  });
});

describe("cleanToolTitle / normalizeToolLabel / normalizeToolName / getToolTitle", () => {
  it("cleanToolTitle strips tool: prefix and leading dots", () => {
    expect(cleanToolTitle("tool: Read")).toBe("Read");
    expect(cleanToolTitle("...Bash")).toBe("Bash");
  });

  it("normalizeToolLabel uses title then tool then fallback", () => {
    expect(normalizeToolLabel(part({ title: "Edit", tool: "Edit" }))).toBe("Edit");
    expect(normalizeToolLabel(part({ title: "", tool: "Write" }))).toBe("Write");
    expect(normalizeToolLabel(part({ title: "", tool: "" }))).toBe("tool");
  });

  it("normalizeToolName lowercases", () => {
    expect(normalizeToolName(part({ title: "Read" }))).toBe("read");
  });

  it("getToolTitle prefers clean title, falls back to tool then default", () => {
    expect(getToolTitle(part({ title: "Read", tool: "read" }))).toBe("Read");
    expect(getToolTitle(part({ title: "", tool: "Write" }))).toBe("Write");
    expect(getToolTitle(part({ title: "", tool: "" }))).toBe("Tool");
  });
});

describe("formatToolOutput / getOutputOrErrorText", () => {
  it("formatToolOutput normalizes escaped newlines", () => {
    expect(formatToolOutput("line1\\nline2")).toBe("line1\nline2");
  });

  it("formatToolOutput falls back to No output captured", () => {
    expect(formatToolOutput(null)).toBe("No output captured.");
    expect(formatToolOutput("")).toBe("No output captured.");
  });

  it("getOutputOrErrorText prefers output, then error", () => {
    const state: NormalizedToolState = {
      status: "completed",
      inputValue: null,
      outputValue: "done",
      errorValue: "oops",
      metadataValue: null,
      inputText: "",
      command: "",
    };
    expect(getOutputOrErrorText(state)).toBe("done");

    const errState = { ...state, outputValue: null };
    expect(getOutputOrErrorText(errState)).toBe("oops");

    const emptyState = { ...state, outputValue: null, errorValue: null };
    expect(getOutputOrErrorText(emptyState)).toBe("No output captured.");
  });
});

describe("extractCommand", () => {
  it("extracts cmd or command from parsed input", () => {
    expect(extractCommand('{"cmd":"ls -la"}')).toBe("ls -la");
    expect(extractCommand('{"command":"pwd"}')).toBe("pwd");
    expect(extractCommand("not json")).toBe("");
  });
});

describe("normalizeEscapedNewlines", () => {
  it("replaces literal backslash-n with newlines", () => {
    expect(normalizeEscapedNewlines("a\\nb\\nc")).toBe("a\nb\nc");
  });
});
