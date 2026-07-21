import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseJsonlLines, readJsonlFile, readJsonlFileLines } from "../jsonl.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../diagnostics.js";

function collect<T>(gen: Generator<T>): T[] {
  return Array.from(gen);
}

const tempDirs: string[] = [];

function writeTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-jsonl-test-"));
  tempDirs.push(dir);
  const filePath = join(dir, "data.jsonl");
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  setCoreDiagnostics(null);
});

function collectDiagnostics(): Array<{ event: string; detail?: Record<string, unknown> }> {
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const diagnostics: CoreDiagnostics = {
    warn: (event, detail) => events.push({ event, detail }),
  };
  setCoreDiagnostics(diagnostics);
  return events;
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

  it("reports skipped lines via diagnostics", () => {
    const events = collectDiagnostics();
    const input = '{"valid":true}\nnot json\n{"also":true}';
    collect(parseJsonlLines(input));

    expect(events).toEqual([
      { event: "agent.jsonl_lines_skipped", detail: { skipped: 1, total: 3 } },
    ]);
  });

  it("does not report diagnostics when every line parses", () => {
    const events = collectDiagnostics();
    collect(parseJsonlLines('{"a":1}\n{"b":2}'));
    expect(events).toEqual([]);
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

describe("readJsonlFileLines", () => {
  it("streams lines split across chunk boundaries", () => {
    const filePath = writeTempFile('{"a":1}\n{"b":2}\n{"c":3}');
    const result = collect(readJsonlFileLines(filePath, 4));
    expect(result).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("reassembles multi-byte characters split across chunks", () => {
    const filePath = writeTempFile('{"标题":"你好世界"}\n{"次":"再见"}\n');
    const result = collect(readJsonlFileLines(filePath, 5));
    expect(result).toEqual(['{"标题":"你好世界"}', '{"次":"再见"}']);
  });

  it("skips blank lines and yields a tail without trailing newline", () => {
    const filePath = writeTempFile('{"a":1}\n\n  \n{"b":2}');
    const result = collect(readJsonlFileLines(filePath));
    expect(result).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("returns nothing for an empty file", () => {
    const filePath = writeTempFile("");
    expect(collect(readJsonlFileLines(filePath))).toEqual([]);
  });
});

describe("readJsonlFile", () => {
  it("reads and parses a valid JSONL file", () => {
    const filePath = writeTempFile('{"name":"alice"}\n{"name":"bob"}');
    const result = collect(readJsonlFile(filePath));
    expect(result).toEqual([{ name: "alice" }, { name: "bob" }]);
  });

  it("skips malformed lines", () => {
    const filePath = writeTempFile('{"valid":true}\nnot json\n{"also":true}');
    const result = collect(readJsonlFile(filePath));
    expect(result).toEqual([{ valid: true }, { also: true }]);
  });

  it("throws when file does not exist", () => {
    expect(() => collect(readJsonlFile("/missing.jsonl"))).toThrow();
  });

  it("reports skipped lines via diagnostics", () => {
    const events = collectDiagnostics();
    const filePath = writeTempFile('{"valid":true}\nnot json\n{"also":true}');
    collect(readJsonlFile(filePath));

    expect(events).toEqual([
      { event: "agent.jsonl_lines_skipped", detail: { skipped: 1, total: 3, filePath } },
    ]);
  });
});
