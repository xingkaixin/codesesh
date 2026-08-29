import { describe, expect, it } from "vitest";
import type { Message, SessionDetail } from "./api";
import { formatSessionAsMarkdown } from "./session-markdown";

function session(messages: Message[], overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    reference: { agentName: "codex", sessionId: "session-1" },
    title: "Raw title",
    display_title: "Demo Session",
    directory: "/repo/codesesh",
    time_created: 1,
    stats: {
      message_count: messages.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages,
    ...overrides,
  };
}

describe("formatSessionAsMarkdown", () => {
  it("preserves message order and renders every normalized part type", () => {
    const markdown = formatSessionAsMarkdown(
      session([
        {
          id: "user-1",
          role: "user",
          time_created: 1,
          parts: [{ type: "text", text: "Please inspect `README.md`." }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          time_created: 2,
          parts: [
            { type: "reasoning", text: "I should read it." },
            { type: "plan", text: "1. Read\n2. Answer", approval_status: "success" },
            {
              type: "tool",
              tool: "read",
              title: "Tool: read",
              state: {
                status: "completed",
                input: { path: "README.md" },
                output: [{ type: "text", text: "# CodeSesh" }],
                metadata: { duration_ms: 12 },
              },
            },
            { type: "text", text: "Done." },
            { type: "image", url: "https://example.com/shot.png" },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          time_created: 3,
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "error",
                input: '{"command":"exit 1"}',
                error: "command failed",
              },
            },
            { type: "plan", text: "Do not run it again", approval_status: "fail" },
          ],
        },
      ]),
    );

    expect(markdown).toBe(`# Demo Session

- Agent: \`codex\`
- Session ID: \`session-1\`
- Directory: \`/repo/codesesh\`

## User

Please inspect \`README.md\`.

## Assistant

### Reasoning

I should read it.

### Plan

1. Read
2. Answer

### Tool: \`read\`

Status: \`completed\`

#### Input

\`\`\`json
{
  "path": "README.md"
}
\`\`\`

#### Output

\`\`\`json
[
  {
    "type": "text",
    "text": "# CodeSesh"
  }
]
\`\`\`

#### Metadata

\`\`\`json
{
  "duration_ms": 12
}
\`\`\`

Done.

![Image](<https://example.com/shot.png>)

## Tool

### Tool: \`bash\`

Status: \`error\`

#### Input

\`\`\`json
{
  "command": "exit 1"
}
\`\`\`

#### Error

\`\`\`text
command failed
\`\`\`

### Rejected plan

Do not run it again
`);
  });

  it("uses a longer fence when tool text contains fenced Markdown", () => {
    const markdown = formatSessionAsMarkdown(
      session([
        {
          id: "assistant-1",
          role: "assistant",
          time_created: 1,
          parts: [
            {
              type: "tool",
              tool: "write",
              state: { status: "completed", output: "before\n```ts\nconst x = 1;\n```\nafter" },
            },
          ],
        },
      ]),
    );

    expect(markdown).toContain("````text\nbefore\n```ts\nconst x = 1;\n```\nafter\n````");
  });

  it("omits embedded image data and empty messages", () => {
    const markdown = formatSessionAsMarkdown(
      session([
        { id: "empty", role: "assistant", time_created: 1, parts: [] },
        {
          id: "image",
          role: "user",
          time_created: 2,
          parts: [{ type: "image", mime_type: "image/png", data: "very-large-base64" }],
        },
      ]),
    );

    expect(markdown).toContain("## User\n\n_Embedded image (image/png) omitted._");
    expect(markdown).not.toContain("## Assistant");
    expect(markdown).not.toContain("very-large-base64");
  });

  it("states when a session has no displayable messages", () => {
    expect(formatSessionAsMarkdown(session([]))).toContain("_No displayable messages._");
  });
});
