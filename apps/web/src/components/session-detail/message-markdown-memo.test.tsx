import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "../MarkdownContent";
import { MessageList, VIRTUALIZED_MESSAGE_THRESHOLD } from "./message-list";
import type { FilteredSessionMessage } from "./toc";

const { markdownRender } = vi.hoisted(() => ({
  markdownRender: vi.fn(),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    markdownRender(children);
    return <span>{children}</span>;
  },
}));

afterEach(() => {
  cleanup();
  markdownRender.mockClear();
  vi.restoreAllMocks();
});

function createMessages(): FilteredSessionMessage[] {
  return Array.from({ length: VIRTUALIZED_MESSAGE_THRESHOLD + 1 }, (_, index) => ({
    msg: {
      id: `message-${index}`,
      role: "user",
      time_created: index,
      parts: [],
    } as FilteredSessionMessage["msg"],
    blocks: [
      {
        type: "text",
        parts: [{ type: "text", text: `Message ${index}` }],
      },
    ],
    index,
  }));
}

describe("message markdown memoization", () => {
  it("reuses parsed markdown until its text or highlight changes", () => {
    const view = render(<MarkdownContent text="Memoized markdown" />);
    expect(markdownRender).toHaveBeenCalledOnce();

    view.rerender(<MarkdownContent text="Memoized markdown" />);
    expect(markdownRender).toHaveBeenCalledOnce();

    view.rerender(<MarkdownContent text="Memoized markdown" highlightQuery="memoized" />);
    expect(markdownRender).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("mark")?.textContent).toBe("Memoized");
  });

  it("does not reparse stable visible messages on viewport updates", () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledFrame = callback;
        return 1;
      });
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const messages = createMessages();
    const view = render(
      <MessageList
        messages={messages}
        sessionAgentKey="codex"
        baseDirectory="/tmp/project"
        apiRef={{ current: null }}
      />,
      { container: scrollContainer },
    );
    const initialRenderCount = markdownRender.mock.calls.length;
    expect(initialRenderCount).toBeGreaterThan(0);

    scrollContainer.scrollTop = 1;
    fireEvent.scroll(scrollContainer);
    expect(requestFrame).toHaveBeenCalledOnce();
    act(() => scheduledFrame?.(0));

    expect(markdownRender).toHaveBeenCalledTimes(initialRenderCount);

    view.rerender(
      <MessageList
        messages={messages}
        sessionAgentKey="codex"
        baseDirectory="/tmp/project"
        highlightQuery="Message"
        apiRef={{ current: null }}
      />,
    );
    expect(markdownRender.mock.calls.length).toBeGreaterThan(initialRenderCount);
    expect(view.container.querySelectorAll("mark").length).toBeGreaterThan(0);
    scrollContainer.remove();
  });
});
