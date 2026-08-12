import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, ToolPart } from "../../lib/api";
import type { MessageBlock } from "./blocks";

const normalizeToolStateCalls = vi.hoisted(() => vi.fn());

vi.mock("./tool-strategy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-strategy")>();
  return {
    ...actual,
    normalizeToolState: (...args: Parameters<typeof actual.normalizeToolState>) => {
      normalizeToolStateCalls();
      return actual.normalizeToolState(...args);
    },
  };
});

import { MessageItem } from "./message-rendering";

afterEach(() => {
  cleanup();
  normalizeToolStateCalls.mockClear();
});

describe("MessageItem", () => {
  it("reuses normalized tool state when only highlighting changes", () => {
    const tool: ToolPart = {
      type: "tool",
      tool: "Write",
      state: {
        status: "completed",
        input: { file_path: "/repo/output.txt", content: "payload".repeat(1_000) },
        output: "written",
      },
    };
    const message: Message = {
      id: "m1",
      role: "assistant",
      time_created: 1,
      parts: [tool],
    };
    const blocks: MessageBlock[] = [{ type: "tool", parts: [tool] }];
    const props = {
      messageIndex: 0,
      msg: message,
      blocks,
      formatTokens: (value: number) => String(value),
      sessionAgentKey: "codex",
      baseDirectory: "/repo",
    };
    const view = render(
      <MemoryRouter>
        <MessageItem {...props} highlightQuery="first" />
      </MemoryRouter>,
    );

    view.rerender(
      <MemoryRouter>
        <MessageItem {...props} highlightQuery="second" />
      </MemoryRouter>,
    );

    expect(normalizeToolStateCalls).toHaveBeenCalledOnce();
  });
});
