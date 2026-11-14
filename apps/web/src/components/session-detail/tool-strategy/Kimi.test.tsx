import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { MessageItem } from "../MessageRendering";
import { buildMessageBlocks } from "../blocks";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

afterEach(cleanup);

function display(agent: string, tool: ToolPart) {
  return getToolDisplayStrategy(agent, tool, normalizeToolState(tool), "/repo");
}

describe("Kimi tool semantics", () => {
  it("marks native done todos as completed while retaining other task states", () => {
    const strategy = display("kimi-code", {
      type: "tool",
      tool: "TodoList",
      title: "todo",
      state: {
        status: "completed",
        input: {
          todos: [
            { title: "Inspect input", status: "done" },
            { title: "Apply change", status: "in_progress" },
            { title: "Verify result", status: "pending" },
          ],
        },
      },
    });

    expect(strategy.outputContent.kind).toBe("plain");
    if (strategy.outputContent.kind !== "plain") throw new Error("Expected todo text");
    expect(strategy.outputContent.text.match(/^- \[(.)\]/gm)).toEqual(["- [x]", "- [~]", "- [ ]"]);
  });

  it("uses compatibility edit.old/new as the requested replacement diff", () => {
    const strategy = display("kimi-code", {
      type: "tool",
      tool: "StrReplaceFile",
      title: "edit",
      state: {
        status: "completed",
        input: { path: "/repo/src/example.ts", edit: { old: "before", new: "after" } },
        output: [{ type: "text", text: "<system>File successfully edited.</system>" }],
      },
    });

    expect(strategy.outputContent).toMatchObject({
      kind: "structured-diff",
      blocks: [
        {
          lines: [
            { type: "remove", text: "before" },
            { type: "add", text: "after" },
          ],
        },
      ],
    });
  });

  it("retains every replacement in compatibility edit arrays", () => {
    const strategy = display("kimi-code", {
      type: "tool",
      tool: "StrReplaceFile",
      state: {
        status: "completed",
        input: {
          path: "/repo/src/example.ts",
          edit: [
            { old: "before", new: "after" },
            { old: "first", new: "second" },
          ],
        },
        output: [{ type: "text", text: "<system>File successfully edited.</system>" }],
      },
    });

    expect(strategy.outputContent.kind).toBe("structured-diff");
    if (strategy.outputContent.kind !== "structured-diff") throw new Error("Expected edit diff");
    expect(strategy.outputContent.blocks.flatMap((block) => block.lines)).toEqual([
      { type: "remove", text: "before" },
      { type: "add", text: "after" },
      { type: "remove", text: "first" },
      { type: "add", text: "second" },
    ]);
  });

  it.each([
    ["kimi", "ReadFile"],
    ["kimi-code", "ReadFile"],
    ["kimi-code", "Read"],
  ])("retains the requested line range for %s %s", (agent, name) => {
    const tool: ToolPart = {
      type: "tool",
      tool: name,
      state: {
        status: "completed",
        input: { path: "/repo/src/example.ts", line_offset: 980, n_lines: 60 },
        output: [
          { type: "text", text: "<system>1 line read from line 980.</system>" },
          { type: "text", text: "980\texport const value = 1;" },
        ],
      },
    };

    const strategy = display(agent, tool);
    expect(strategy.details).toEqual([
      { label: "Offset", value: "980" },
      { label: "Lines", value: "60" },
    ]);
    expect(strategy.outputContent).toMatchObject({ text: "export const value = 1;" });
    expect(
      display(agent, {
        ...tool,
        state: { ...tool.state, input: { path: "/repo/src/example.ts", line_offset: 1 } },
      }).details,
    ).toEqual([{ label: "Offset", value: "1" }]);
  });

  it.each(["kimi", "kimi-code"])(
    "makes the full Agent task available when expanded in %s",
    (agent) => {
      const prompt = "Inspect src/example.ts. Include a reproduction and validation steps.";
      const tool: ToolPart = {
        type: "tool",
        tool: "Agent",
        state: {
          status: "completed",
          input: { description: "Inspect parser", subagent_type: "explore", prompt },
          output: [{ type: "text", text: "Inspection complete." }],
        },
      };
      render(
        <MessageItem
          messageIndex={0}
          msg={{ id: "assistant", role: "assistant", time_created: 0, parts: [tool] }}
          blocks={buildMessageBlocks([tool])}
          formatTokens={String}
          sessionAgentKey={agent}
          baseDirectory="/repo"
        />,
      );

      expect(screen.queryByText(prompt, { exact: false })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /explore.*Inspect parser/ }));
      expect(screen.getByText(prompt, { exact: false })).toBeTruthy();
      expect(screen.getByText("Inspection complete.")).toBeTruthy();
    },
  );

  it.each(["kimi", "kimi-code"])("shows the SearchWeb query and results in %s", (agent) => {
    const strategy = display(agent, {
      type: "tool",
      tool: "SearchWeb",
      state: {
        status: "completed",
        input: { query: "Rust error handling", limit: 5, include_content: true },
        output: [{ type: "text", text: "Rust documentation: https://doc.rust-lang.org/" }],
      },
    });

    expect(strategy.secondaryText).toBe("Rust error handling");
    expect(strategy.outputContent).toMatchObject({
      kind: "plain",
      text: "Rust documentation: https://doc.rust-lang.org/",
    });
  });
});
