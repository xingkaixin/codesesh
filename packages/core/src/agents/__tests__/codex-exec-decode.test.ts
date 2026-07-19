import { describe, expect, it } from "vitest";
import {
  decodeExecCalls,
  getExecPatchText,
  pickExecOutputTarget,
  splitExecToolName,
  stripExecOutputEnvelope,
} from "../codex-exec-decode.js";

describe("decodeExecCalls", () => {
  it("decodes a single exec_command invocation with inline args", () => {
    const input =
      'const r = await tools.exec_command({cmd:"sed -n \'1,20p\' a.md",workdir:"/tmp/p",yield_time_ms:10000,max_output_tokens:20000}); text(r.output)';
    expect(decodeExecCalls(input)).toEqual([
      {
        name: "exec_command",
        args: {
          cmd: "sed -n '1,20p' a.md",
          workdir: "/tmp/p",
          yield_time_ms: 10000,
          max_output_tokens: 20000,
        },
      },
    ]);
  });

  it("resolves an apply_patch shorthand against the declared patch variable", () => {
    const input =
      'const patch = "*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch";\nconst r = await tools.apply_patch({patch}); text(r.output)';
    const calls = decodeExecCalls(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("apply_patch");
    expect(getExecPatchText(calls[0]!.args)).toBe(
      "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch",
    );
  });

  it("preserves escaped quotes and backslashes inside patch strings", () => {
    const input = 'const patch = "a: \\"x\\"\\npath\\\\to"; await tools.apply_patch({patch});';
    const calls = decodeExecCalls(input);
    expect(getExecPatchText(calls[0]!.args)).toBe('a: "x"\npath\\to');
  });

  it("decodes nested arrays and objects for update_plan", () => {
    const input =
      'await tools.update_plan({plan:[{step:"a",status:"done"},{step:"b",status:"pending"}],explanation:"go"})';
    expect(decodeExecCalls(input)).toEqual([
      {
        name: "update_plan",
        args: {
          plan: [
            { step: "a", status: "done" },
            { step: "b", status: "pending" },
          ],
          explanation: "go",
        },
      },
    ]);
  });

  it("returns every invocation for multi-tool programs", () => {
    const input =
      'let r = await tools.exec_command({cmd:"ls"}); const patch = "*** Begin Patch\\n*** End Patch"; await tools.apply_patch({patch});';
    const calls = decodeExecCalls(input);
    expect(calls.map((call) => call.name)).toEqual(["exec_command", "apply_patch"]);
  });

  it("ignores programs without tool calls", () => {
    expect(decodeExecCalls("const x = 1; console.log(x)")).toEqual([]);
    expect(decodeExecCalls(undefined)).toEqual([]);
  });
});

describe("splitExecToolName", () => {
  it("splits MCP namespaced tool names", () => {
    expect(splitExecToolName("mcp__node_repl__js")).toEqual({
      name: "js",
      namespace: "mcp__node_repl__",
    });
  });

  it("leaves plain tool names untouched", () => {
    expect(splitExecToolName("exec_command")).toEqual({ name: "exec_command" });
    expect(splitExecToolName("apply_patch")).toEqual({ name: "apply_patch" });
  });
});

describe("pickExecOutputTarget", () => {
  const call = (name: string) => ({ name, args: {} });

  it("prefers the last output-bearing call over patch/plan", () => {
    expect(pickExecOutputTarget([call("exec_command"), call("apply_patch")])).toBe(0);
    expect(pickExecOutputTarget([call("update_plan"), call("exec_command")])).toBe(1);
  });

  it("falls back to the last call when all are patch/plan", () => {
    expect(pickExecOutputTarget([call("apply_patch"), call("update_plan")])).toBe(1);
  });
});

describe("stripExecOutputEnvelope", () => {
  it("removes the code-mode output wrapper", () => {
    expect(stripExecOutputEnvelope("Script completed\nWall time 2.3 seconds\nOutput:\nhello")).toBe(
      "hello",
    );
  });

  it("leaves classic output untouched", () => {
    expect(stripExecOutputEnvelope("package.json")).toBe("package.json");
  });
});
