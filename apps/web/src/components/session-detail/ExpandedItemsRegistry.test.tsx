import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionDetail as Detail } from "@codesesh/contract";
import { createAgentCatalog } from "../../lib/agents";
import { SessionDetail } from "../SessionDetail";
import { VIRTUALIZED_MESSAGE_THRESHOLD } from "./MessageList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function buildSession(sessionId: string, messageCount: number): Detail {
  const firstMessage = {
    id: `${sessionId}-m0`,
    role: "assistant" as const,
    time_created: 1,
    parts: [
      { type: "reasoning" as const, text: `Reasoning detail ${sessionId}` },
      {
        type: "plan" as const,
        text: `Plan body ${sessionId}`,
        approval_status: "success" as const,
      },
      {
        type: "tool" as const,
        tool: "Read",
        state: {
          status: "completed" as const,
          input: { file_path: "/repo/src/main.ts" },
          output: `Tool output ${sessionId}`,
        },
      },
    ],
  };

  const filler = Array.from({ length: Math.max(0, messageCount - 1) }, (_, index) => ({
    id: `${sessionId}-m${index + 1}`,
    role: "user" as const,
    time_created: index + 2,
    parts: [{ type: "text" as const, text: `Filler message ${index + 1}` }],
  }));

  return {
    reference: { agentName: "claudecode", sessionId },
    title: `Session ${sessionId}`,
    directory: "/repo",
    time_created: 1,
    stats: {
      message_count: messageCount,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages: [firstMessage, ...filler],
  };
}

it("preserves expanded tool, reasoning, and plan cards across virtualized unmount and remount", () => {
  const rafQueue: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const parent = document.createElement("div");
  parent.style.overflowY = "auto";
  document.body.append(parent);
  Object.defineProperty(parent, "clientHeight", { value: 600 });
  Object.defineProperty(parent, "scrollHeight", { value: 30000 });
  parent.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object" && options.top != null) parent.scrollTop = options.top;
  };

  const flushFrames = () => {
    act(() => {
      while (rafQueue.length > 0) rafQueue.shift()?.(16);
    });
  };

  const session = buildSession("virt", VIRTUALIZED_MESSAGE_THRESHOLD + 20);
  const view = render(<SessionDetail session={session} agentCatalog={createAgentCatalog([])} />, {
    container: parent,
  });
  const virtualContainer = view.container.querySelector<HTMLElement>(".relative.min-w-0");
  expect(virtualContainer).not.toBeNull();
  vi.spyOn(virtualContainer!, "getBoundingClientRect").mockImplementation(
    () => ({ top: -parent.scrollTop, bottom: 30000 - parent.scrollTop }) as DOMRect,
  );
  flushFrames();

  const reasoningButton = view.getByRole("button", { name: /Thinking/i });
  const planButton = view.getByRole("button", { name: /^plan$/i });
  const toolButton = view.getByRole("button", { name: /read.*src\/main\.ts/i });

  fireEvent.click(reasoningButton);
  fireEvent.click(planButton);
  fireEvent.click(toolButton);

  expect(view.container.textContent).toContain("Reasoning detail virt");
  expect(view.container.textContent).toContain("Plan body virt");
  expect(view.container.textContent).toContain("Tool output virt");

  // Scroll far away so message 0 unmounts from the virtualized window.
  act(() => {
    parent.scrollTop = 20000;
    fireEvent.scroll(parent);
  });
  flushFrames();

  expect(view.queryByText(/Reasoning detail virt/)).toBeNull();
  expect(view.queryByText(/Tool output virt/)).toBeNull();

  // Scroll back to the top; all three cards should remount still expanded.
  act(() => {
    parent.scrollTop = 0;
    fireEvent.scroll(parent);
  });
  flushFrames();

  expect(view.container.textContent).toContain("Reasoning detail virt");
  expect(view.container.textContent).toContain("Plan body virt");
  expect(view.container.textContent).toContain("Tool output virt");

  view.unmount();
  parent.remove();
});

it("toggles all collapsible blocks via Expand all / Collapse all and resets on session switch", () => {
  const catalog = createAgentCatalog([]);
  const sessionA = buildSession("session-a", 3);
  const sessionB = buildSession("session-b", 3);

  const view = render(<SessionDetail session={sessionA} agentCatalog={catalog} />);

  expect(view.container.textContent).not.toContain("Reasoning detail session-a");
  expect(view.container.textContent).not.toContain("Plan body session-a");
  expect(view.container.textContent).not.toContain("Tool output session-a");

  fireEvent.click(view.getByRole("button", { name: "Expand all" }));

  expect(view.container.textContent).toContain("Reasoning detail session-a");
  expect(view.container.textContent).toContain("Plan body session-a");
  expect(view.container.textContent).toContain("Tool output session-a");

  const collapseButton = view.getByRole("button", { name: "Collapse all" });
  expect(collapseButton.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(collapseButton);

  expect(view.container.textContent).not.toContain("Reasoning detail session-a");
  expect(view.container.textContent).not.toContain("Plan body session-a");
  expect(view.container.textContent).not.toContain("Tool output session-a");

  // Expand all again, then switch sessions and verify expanded state resets.
  fireEvent.click(view.getByRole("button", { name: "Expand all" }));
  expect(view.container.textContent).toContain("Tool output session-a");

  view.rerender(<SessionDetail session={sessionB} agentCatalog={catalog} />);

  expect(view.getByRole("button", { name: "Expand all" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("Reasoning detail session-b");
  expect(view.container.textContent).not.toContain("Plan body session-b");
  expect(view.container.textContent).not.toContain("Tool output session-b");
});

it("auto-expands matched collapsed cards, highlights tool output, and clears highlights cleanly", () => {
  const catalog = createAgentCatalog([]);
  const onClearHighlight = vi.fn();
  const session: Detail = {
    reference: { agentName: "claudecode", sessionId: "search-expand" },
    title: "Search expand",
    directory: "/repo",
    time_created: 1,
    stats: {
      message_count: 2,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages: [
      {
        id: "m0",
        role: "assistant",
        time_created: 1,
        parts: [
          { type: "reasoning", text: "Unrelated thinking block" },
          {
            type: "tool",
            tool: "Read",
            state: {
              status: "completed",
              input: { file_path: "/repo/src/other.ts" },
              output: "nothing interesting here",
            },
          },
        ],
      },
      {
        id: "m1",
        role: "assistant",
        time_created: 2,
        parts: [
          { type: "reasoning", text: "Investigating needleToken in reasoning" },
          {
            type: "plan",
            text: "Plan step referencing needleToken",
            approval_status: "success",
          },
          {
            type: "tool",
            tool: "Bash",
            state: {
              status: "completed",
              input: { command: "pnpm test" },
              output: "FAIL: needleToken mismatch",
            },
          },
        ],
      },
    ],
  };

  const view = render(
    <SessionDetail
      session={session}
      agentCatalog={catalog}
      highlightQuery="needleToken"
      onClearHighlight={onClearHighlight}
      targetMessageIndex={1}
    />,
  );

  // Matching collapsed cards auto-expand while non-matching cards stay collapsed.
  expect(view.container.textContent).not.toContain("Unrelated thinking block");
  expect(view.container.textContent).not.toContain("nothing interesting here");
  expect(view.container.textContent).toContain("Investigating needleToken in reasoning");
  expect(view.container.textContent).toContain("Plan step referencing needleToken");
  expect(view.container.textContent).toContain("FAIL: needleToken mismatch");

  const initialMarks = Array.from(view.container.querySelectorAll("mark"), (n) => n.textContent);
  expect(initialMarks.length).toBeGreaterThanOrEqual(3);
  expect(initialMarks.every((text) => text === "needleToken")).toBe(true);

  // Manual collapse on an auto-expanded card stays collapsed.
  const matchedToolButton = view.getByRole("button", { name: /bash.*pnpm test/i });
  expect(matchedToolButton.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(matchedToolButton);
  expect(matchedToolButton.getAttribute("aria-expanded")).toBe("false");

  // Clear highlights removes <mark> elements and hides the highlight chip.
  fireEvent.click(view.getByRole("button", { name: /Clear highlights/i }));
  expect(onClearHighlight).toHaveBeenCalledOnce();
  expect(view.queryByRole("button", { name: /Clear highlights/i })).toBeNull();
  expect(view.container.querySelectorAll("mark")).toHaveLength(0);
});
