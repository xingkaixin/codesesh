import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, SessionDetail as Detail } from "@codesesh/contract";
import { createAgentCatalog } from "../../lib/agents";
import { SessionDetail } from "../SessionDetail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildSession(messages: Message[], overrides: Partial<Detail> = {}): Detail {
  return {
    reference: { agentName: "claudecode", sessionId: "find-session" },
    title: "Find session",
    directory: "/repo",
    time_created: 1,
    stats: {
      message_count: overrides.message_total ?? messages.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages,
    ...overrides,
  };
}

describe("Find in Session", () => {
  it("opens with f, cycles 1 / N across text and collapsed cards, auto-expands matches, and closes with Escape", async () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this.id);
    });

    const session = buildSession([
      {
        id: "m0",
        role: "user",
        time_created: 1,
        parts: [{ type: "text", text: "Please check needleToken in the logs" }],
      },
      {
        id: "m1",
        role: "assistant",
        time_created: 2,
        parts: [
          { type: "reasoning", text: "Unrelated thinking" },
          {
            type: "tool",
            tool: "Bash",
            state: {
              status: "completed",
              input: { command: "grep needleToken" },
              output: "matched needleToken in output",
            },
          },
        ],
      },
      {
        id: "m2",
        role: "assistant",
        time_created: 3,
        parts: [
          {
            type: "plan",
            text: "Plan step to fix needleToken",
            approval_status: "success",
          },
        ],
      },
    ]);

    const view = render(<SessionDetail session={session} agentCatalog={createAgentCatalog([])} />);

    // Collapsed cards stay hidden before search.
    expect(view.container.textContent).not.toContain("matched needleToken in output");
    expect(view.container.textContent).not.toContain("Plan step to fix needleToken");

    fireEvent.keyDown(window, { key: "f" });
    const input = screen.getByRole("searchbox", { name: "Find in session" });
    fireEvent.change(input, { target: { value: "needleToken" } });

    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(view.container.textContent).toContain("matched needleToken in output");
    expect(view.container.textContent).toContain("Plan step to fix needleToken");
    expect(view.container.textContent).not.toContain("Unrelated thinking");
    expect(view.container.querySelectorAll("mark").length).toBeGreaterThanOrEqual(3);

    await waitFor(() => expect(scrolled).toContain("session-message-0"));

    // Enter advances to match 2 / 3 and 3 / 3, then wraps back to 1 / 3.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(scrolled.at(-1)).toBe("tool-1-0");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(scrolled.at(-1)).toBe("session-message-2-block-0");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("1 / 3")).toBeTruthy();

    // Shift+Enter steps backward to 3 / 3.
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3 / 3")).toBeTruthy();

    // Escape closes the bar, clears highlights, and prevents default so global Esc doesn't navigate away.
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(escEvent);
    expect(escEvent.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("searchbox", { name: "Find in session" })).toBeNull(),
    );
    expect(view.container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("queries backend matches for paged sessions and auto-loads pages when jumping to an unpaged hit", async () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this.id);
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messageIndices: [0, 3] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const page1Messages: Message[] = [
      {
        id: "m0",
        role: "user",
        time_created: 1,
        parts: [{ type: "text", text: "First needleToken on page 1" }],
      },
      {
        id: "m1",
        role: "assistant",
        time_created: 2,
        parts: [{ type: "text", text: "Filler reply" }],
      },
    ];
    const page2Messages: Message[] = [
      ...page1Messages,
      {
        id: "m2",
        role: "user",
        time_created: 3,
        parts: [{ type: "text", text: "Another filler message" }],
      },
      {
        id: "m3",
        role: "assistant",
        time_created: 4,
        parts: [
          {
            type: "tool",
            tool: "Read",
            state: {
              status: "completed",
              input: { file_path: "/repo/deep.ts" },
              output: "Deep page needleToken hit",
            },
          },
        ],
      },
    ];

    const loadMore = vi.fn();
    const catalog = createAgentCatalog([]);
    const initialSession = buildSession(page1Messages, {
      reference: { sourceNodeId: "worker-a", agentName: "claudecode", sessionId: "paged-1" },
      message_total: 4,
    });

    const view = render(
      <SessionDetail
        session={initialSession}
        agentCatalog={catalog}
        messagePaging={{ loading: false, failed: false, loadMore }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Find in session/i }));
    const input = screen.getByRole("searchbox", { name: "Find in session" });
    fireEvent.change(input, { target: { value: "needleToken" } });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/sessions/nodes/worker-a/claudecode/paged-1/matches?q=needleToken",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByText("1 / 2")).toBeTruthy();
    });

    // Jumping to the second match (index 3, unpaged) triggers loadMore automatically.
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    expect(screen.getByText("2 / 2")).toBeTruthy();

    // Once page 2 arrives, the unpaged tool card expands and scrolls into view.
    view.rerender(
      <SessionDetail
        session={buildSession(page2Messages, {
          reference: { sourceNodeId: "worker-a", agentName: "claudecode", sessionId: "paged-1" },
          message_total: 4,
        })}
        agentCatalog={catalog}
      />,
    );

    await waitFor(() => expect(scrolled).toContain("tool-3-0"));
    expect(view.container.textContent).toContain("Deep page needleToken hit");
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });
});
