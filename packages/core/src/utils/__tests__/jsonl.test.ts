import { describe, it, expect, vi, beforeEach } from "vitest";

// Module-level mock for readFileSync
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

import { readFileSync } from "node:fs";
import { parseJsonlLines, readJsonlFile } from "../jsonl.js";

const mockedReadFileSync = vi.mocked(readFileSync);

function collect<T>(gen: Generator<T>): T[] {
  return Array.from(gen);
}

describe("parseJsonlLines", () => {
  it("returns empty for empty string", () => {
    expect(collect(parseJsonlLines(""))).toEqual([]);
  });

  it("returns empty for whitespace-only", () => {
    expect(collect(parseJsonlLines("  \n  \n"))).toEqual([]);
  });

  it("parses a single JSON line", () => {
    const result = collect(parseJsonlLines('{"key":"value"}'));
    expect(result).toEqual([{ key: "value" }]);
  });

  it("parses multiple JSON lines", () => {
    const input = '{"a":1}\n{"b":2}\n{"c":3}';
    const result = collect(parseJsonlLines(input));
    expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("skips malformed lines", () => {
    const input = '{"valid":true}\nnot json\n{"also":true}';
    const result = collect(parseJsonlLines(input));
    expect(result).toEqual([{ valid: true }, { also: true }]);
  });

  it("skips empty lines between valid lines", () => {
    const input = '{"a":1}\n\n{"b":2}';
    const result = collect(parseJsonlLines(input));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles trailing newline", () => {
    const input = '{"a":1}\n';
    const result = collect(parseJsonlLines(input));
    expect(result).toEqual([{ a: 1 }]);
  });
});

describe("readJsonlFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads and parses a valid JSONL file", () => {
    const content = '{"name":"alice"}\n{"name":"bob"}';
    mockedReadFileSync.mockReturnValue(content);
    const result = collect(readJsonlFile("/fake/path.jsonl"));
    expect(result).toEqual([{ name: "alice" }, { name: "bob" }]);
    expect(mockedReadFileSync).toHaveBeenCalledWith("/fake/path.jsonl", "utf-8");
  });

  it("throws when file does not exist", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => collect(readJsonlFile("/missing.jsonl"))).toThrow("ENOENT");
  });
});
