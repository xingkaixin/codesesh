import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentCatalog } from "../lib/agents";
import type { SessionDetail as Detail } from "../lib/api";
import { SessionDetail } from "./SessionDetail";
import { VIRTUALIZED_MESSAGE_THRESHOLD } from "./session-detail/message-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens an offscreen match and keeps the reader position on append", async () => {
  vi.stubGlobal("innerHeight", 0);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  const scrolled: string[] = [];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
    this: HTMLElement,
  ) {
    scrolled.push(this.id);
  });
  const session: Detail = {
    reference: { agentName: "codex", sessionId: "search-target" },
    title: "Search target",
    directory: "/repo",
    time_created: 1,
    stats: { message_count: 100, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    messages: Array.from({ length: VIRTUALIZED_MESSAGE_THRESHOLD + 10 }, (_, index) => ({
      id: "duplicate",
      role: "user",
      time_created: index + 1,
      parts: [{ type: "text", text: `Message ${index}` }],
    })),
  };
  const target = VIRTUALIZED_MESSAGE_THRESHOLD + 5;
  const catalog = createAgentCatalog([]);
  const view = render(
    <StrictMode>
      <SessionDetail session={session} agentCatalog={catalog} targetMessageIndex={target} />
    </StrictMode>,
  );
  await waitFor(() => expect(scrolled).toContain(`session-message-${target}`));
  const scrollCount = scrolled.length;
  view.rerender(
    <StrictMode>
      <SessionDetail
        session={{
          ...session,
          messages: [...session.messages, { ...session.messages[0]!, id: "appended" }],
        }}
        agentCatalog={catalog}
        targetMessageIndex={target}
      />
    </StrictMode>,
  );
  expect(scrolled).toHaveLength(scrollCount);
  view.rerender(
    <StrictMode>
      <SessionDetail session={session} agentCatalog={catalog} targetMessageIndex={2} />
    </StrictMode>,
  );
  await waitFor(() => expect(scrolled.at(-1)).toBe("session-message-2"));
});

it("loads to a search match, stops on page failure and jumps when the target becomes available", async () => {
  const scrolled: string[] = [];
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
    this: HTMLElement,
  ) {
    scrolled.push(this.id);
  });
  const loadMore = vi.fn();
  const catalog = createAgentCatalog([]);
  const session: Detail = {
    reference: { agentName: "codex", sessionId: "paged-search" },
    title: "Paged search",
    directory: "/repo",
    time_created: 1,
    stats: { message_count: 2, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    messages: [
      { id: "first", role: "user", time_created: 1, parts: [{ type: "text", text: "First page" }] },
    ],
    message_total: 2,
  };
  const view = render(
    <SessionDetail
      session={session}
      agentCatalog={catalog}
      targetMessageIndex={1}
      messagePaging={{ loading: false, failed: false, loadMore }}
    />,
  );
  expect(loadMore).toHaveBeenCalledOnce();
  expect(scroll).not.toHaveBeenCalled();
  view.rerender(
    <SessionDetail
      session={session}
      agentCatalog={catalog}
      targetMessageIndex={1}
      messagePaging={{ loading: false, failed: true, loadMore }}
    />,
  );
  expect(loadMore).toHaveBeenCalledOnce();
  view.rerender(
    <SessionDetail
      session={{
        ...session,
        messages: [
          ...session.messages,
          { ...session.messages[0]!, id: "second", parts: [{ type: "text", text: "Target page" }] },
        ],
      }}
      agentCatalog={catalog}
      targetMessageIndex={1}
    />,
  );
  await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
  expect(scrolled[0]).toBe("session-message-1");
});
