import { describe, expect, it } from "vitest";
import {
  buildSemanticOutputContent,
  extractCommand,
  extractToolTextSegments,
  formatToolOutput,
  getOutputOrErrorText,
  joinToolText,
  stripSystemTag,
  type NormalizedToolState,
} from "./tool-normalize";
import { escapeRegExp, parseInputCandidate, parseJsonText, toRecord } from "./utils";

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

describe("buildSemanticOutputContent", () => {
  it("preserves image blocks alongside text", () => {
    expect(
      buildSemanticOutputContent([
        { type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" },
        { type: "text", text: "Browser screenshot" },
      ]),
    ).toEqual({
      kind: "media",
      items: [
        {
          src: "data:image/png;base64,iVBORw0KGgo=",
          alt: "Tool output image 1",
        },
      ],
      text: "Browser screenshot",
    });
  });

  it("turns JSON objects into property rows", () => {
    expect(buildSemanticOutputContent('{"status":"complete","count":3}')).toEqual({
      kind: "property-list",
      items: [
        { label: "status", value: "complete" },
        { label: "count", value: 3 },
      ],
    });
  });

  it("does not load remote image URLs from historical output", () => {
    expect(
      buildSemanticOutputContent([{ type: "image", url: "https://tracker.example/tool.png" }]),
    ).toBeNull();
  });
});

describe("extractCommand", () => {
  it("extracts cmd or command from parsed input", () => {
    expect(extractCommand('{"cmd":"ls -la"}')).toBe("ls -la");
    expect(extractCommand('{"command":"pwd"}')).toBe("pwd");
    expect(extractCommand("not json")).toBe("");
  });
});
