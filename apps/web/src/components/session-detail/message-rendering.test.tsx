import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, PlanPart, ReasoningPart, ToolPart } from "../../lib/api";
import { MarkdownContent } from "../MarkdownContent";
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
  it("CS-258: matches Markdown highlighting for the same query", () => {
    const text = "The quick brown fox";
    const highlightQuery = '"quick brown" OR fox';
    const reasoning: ReasoningPart = { type: "reasoning", text };
    const message: Message = {
      id: "m1",
      role: "assistant",
      time_created: 1,
      parts: [reasoning],
    };
    const blocks: MessageBlock[] = [{ type: "reasoning", parts: [reasoning] }];
    const markdown = render(<MarkdownContent text={text} highlightQuery={highlightQuery} />);
    const messageItem = render(
      <MemoryRouter>
        <MessageItem
          messageIndex={0}
          msg={message}
          blocks={blocks}
          formatTokens={String}
          sessionAgentKey="codex"
          baseDirectory="/repo"
          highlightQuery={highlightQuery}
        />
      </MemoryRouter>,
    );

    fireEvent.click(messageItem.getByRole("button", { name: "Thinking" }));

    const markedText = (container: HTMLElement) =>
      [...container.querySelectorAll("mark")].map((mark) => mark.textContent);

    expect(markedText(messageItem.container)).toEqual(markedText(markdown.container));
  });

  it("CS-258: exposes reasoning expansion through a native button", () => {
    const reasoning: ReasoningPart = { type: "reasoning", text: "Working through the answer" };
    const message: Message = {
      id: "m1",
      role: "assistant",
      time_created: 1,
      parts: [reasoning],
    };
    const blocks: MessageBlock[] = [{ type: "reasoning", parts: [reasoning] }];
    const view = render(
      <MemoryRouter>
        <MessageItem
          messageIndex={0}
          msg={message}
          blocks={blocks}
          formatTokens={String}
          sessionAgentKey="codex"
          baseDirectory="/repo"
        />
      </MemoryRouter>,
    );

    const toggle = view.getByRole("button", { name: "Thinking" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.tabIndex).toBe(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("Working through the answer")).not.toBeNull();
  });

  it("CS-258: exposes plan expansion state to assistive technology", () => {
    const plan: PlanPart = {
      type: "plan",
      text: "1. Implement the change",
      approval_status: "success",
    };
    const message: Message = {
      id: "m1",
      role: "assistant",
      time_created: 1,
      parts: [plan],
    };
    const blocks: MessageBlock[] = [{ type: "plan", parts: [plan] }];
    const view = render(
      <MemoryRouter>
        <MessageItem
          messageIndex={0}
          msg={message}
          blocks={blocks}
          formatTokens={String}
          sessionAgentKey="codex"
          baseDirectory="/repo"
        />
      </MemoryRouter>,
    );

    const toggle = view.getByRole("button", { name: "plan" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

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
