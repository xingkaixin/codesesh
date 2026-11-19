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
