import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Message } from "@codesesh/contract";
import { buildMessageBlocks } from "./blocks";
import { MessageItem } from "./MessageRendering";

afterEach(cleanup);

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
