import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "@codesesh/contract";
import * as diffHelpers from "./diff";
import { buildMessageBlocks } from "./blocks";
import { MessageItem } from "./MessageRendering";
import { getToolDisplayStrategy, normalizeToolState } from "./tool-strategy";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["claudecode", "zcode"])(
  "opens the complete %s delegation input alongside its result",
  (agentName) => {
    const prompt = "Inspect the parser and its real input. ".repeat(30) + "End of task.";
    const result = "Agent launched asynchronously.";
    const message: Message = {
      id: "delegation",
      role: "assistant",
      time_created: 1,
      parts: [
        {
          type: "tool",
          tool: "Agent",
          state: {
            status: "completed",
            input: { subagent_type: "Explore", description: "Inspect parser", prompt },
            output: [{ type: "text", text: result }],
          },
        },
      ],
    };
    const view = render(
      <MessageItem
        messageIndex={0}
        msg={message}
        blocks={buildMessageBlocks(message.parts)}
        formatTokens={String}
        sessionAgentKey={agentName}
        baseDirectory="/repo"
      />,
    );

    fireEvent.click(view.getByRole("button", { expanded: false }));

    expect(view.container.textContent).toContain(prompt);
    expect(view.container.textContent).toContain(result);
  },
);

it("defers edit diff computation until the tool card is expanded", () => {
  const diffSpy = vi.spyOn(diffHelpers, "buildStructuredDiffFromTexts");
  const message: Message = {
    id: "edit-msg",
    role: "assistant",
    time_created: 1,
    parts: [
      {
        type: "tool",
        tool: "Edit",
        state: {
          status: "completed",
          input: {
            file_path: "/repo/src/app.ts",
            old_string: "const before = 1;\n",
            new_string: "const after = 2;\n",
          },
          output: "ok",
        },
      },
    ],
  };

  const view = render(
    <MessageItem
      messageIndex={0}
      msg={message}
      blocks={buildMessageBlocks(message.parts)}
      formatTokens={String}
      sessionAgentKey="claudecode"
      baseDirectory="/repo"
    />,
  );

  // Collapsed header renders title, relative path, and status without computing diffs.
  expect(view.container.textContent).toContain("edit");
  expect(view.container.textContent).toContain("src/app.ts");
  expect(view.container.textContent).toContain("Completed");
  expect(diffSpy).not.toHaveBeenCalled();

  fireEvent.click(view.getByRole("button", { expanded: false }));

  expect(diffSpy).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toContain("const before = 1;");
  expect(view.container.textContent).toContain("const after = 2;");
});

it("keeps collapsed headers identical while skipping diffs in summary-only mode", () => {
  const diffSpy = vi.spyOn(diffHelpers, "buildStructuredDiffFromTexts");
  const tool = {
    type: "tool" as const,
    tool: "Edit",
    state: {
      status: "completed" as const,
      input: {
        file_path: "/repo/src/example.ts",
        old_string: "old line",
        new_string: "new line",
      },
      output: "updated",
    },
  };
  const state = normalizeToolState(tool);

  const summary = getToolDisplayStrategy("claudecode", tool, state, "/repo", {
    includeOutput: false,
  });
  expect(diffSpy).not.toHaveBeenCalled();

  const full = getToolDisplayStrategy("claudecode", tool, state, "/repo");
  expect(diffSpy).toHaveBeenCalledTimes(1);
  expect({
    Icon: summary.Icon,
    title: summary.title,
    secondaryText: summary.secondaryText,
    expandable: summary.expandable,
  }).toEqual({
    Icon: full.Icon,
    title: full.title,
    secondaryText: full.secondaryText,
    expandable: full.expandable,
  });
});

it("highlights search queries in tool output and raw output", () => {
  const message: Message = {
    id: "tool-highlight",
    role: "assistant",
    time_created: 1,
    parts: [
      {
        type: "tool",
        tool: "process",
        state: {
          status: "completed",
          input: { action: "poll", sessionId: "proc-1" },
          output: {
            status: "completed",
            exitCode: 0,
            output: "stdout needleHit line",
          },
        },
      },
    ],
  };

  const view = render(
    <MessageItem
      messageIndex={0}
      msg={message}
      blocks={buildMessageBlocks(message.parts)}
      formatTokens={String}
      sessionAgentKey="deepchat"
      baseDirectory="/repo"
      highlightQuery="needleHit"
    />,
  );

  fireEvent.click(view.getByRole("button", { expanded: false }));
  expect(Array.from(view.container.querySelectorAll("mark"), (node) => node.textContent)).toEqual([
    "needleHit",
  ]);

  const rawDetails = view.getByText("Raw output").closest("details")!;
  rawDetails.open = true;
  fireEvent(rawDetails, new Event("toggle"));

  const rawMarks = Array.from(rawDetails.querySelectorAll("mark"), (node) => node.textContent);
  expect(rawMarks).toEqual(["needleHit"]);
});

it("copies a single message as Markdown from the message header", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

  const message: Message = {
    id: "user-copy-1",
    role: "user",
    time_created: 1,
    parts: [{ type: "text", text: "Explain the retry logic." }],
  };

  const view = render(
    <MessageItem
      messageIndex={0}
      msg={message}
      blocks={buildMessageBlocks(message.parts)}
      formatTokens={String}
      sessionAgentKey="codex"
      baseDirectory="/repo"
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Copy message" }));

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith("## User\n\nExplain the retry logic.");
    expect(view.getByRole("button", { name: "Message copied" })).toBeTruthy();
  });
});
