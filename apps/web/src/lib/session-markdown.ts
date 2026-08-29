import type { ImagePart, Message, MessagePart, SessionDetail, ToolPart } from "./api";
import { getSessionDisplayTitle } from "./session-title";

const messageRoleLabels = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
} satisfies Record<Message["role"], string>;

function backtickDelimiter(text: string, minimumLength: number): string {
  let length = minimumLength;
  for (const match of text.matchAll(/`+/g)) {
    length = Math.max(length, match[0].length + 1);
  }
  return "`".repeat(length);
}

function inlineCode(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const delimiter = backtickDelimiter(text, 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  return `${delimiter}${needsPadding ? " " : ""}${text}${needsPadding ? " " : ""}${delimiter}`;
}

function markdownCodeBlock(content: string, language: "json" | "text"): string {
  const delimiter = backtickDelimiter(content, 3);
  const closingLineBreak = content.endsWith("\n") ? "" : "\n";
  return `${delimiter}${language}\n${content}${closingLineBreak}${delimiter}`;
}

function formattedToolValue(value: unknown): { content: string; language: "json" | "text" } {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        return { content: JSON.stringify(parsed, null, 2), language: "json" };
      }
    } catch {}
    return { content: value, language: "text" };
  }

  try {
    const content = JSON.stringify(value, null, 2);
    if (content !== undefined) return { content, language: "json" };
  } catch {}
  return { content: String(value), language: "text" };
}

function toolValueSection(label: string, value: unknown): string {
  const { content, language } = formattedToolValue(value);
  return `#### ${label}\n\n${markdownCodeBlock(content, language)}`;
}

function toolLabel(part: ToolPart): string {
  return (part.title?.trim() || part.tool.trim() || "tool").replace(/^tool:\s*/i, "");
}

function formatToolPart(part: ToolPart): string {
  const sections = [
    `### Tool: ${inlineCode(toolLabel(part))}`,
    `Status: ${inlineCode(part.state.status)}`,
  ];
  if (part.state.input !== undefined) {
    sections.push(toolValueSection("Input", part.state.input));
  }
  if (part.state.output !== undefined && part.state.output !== null) {
    sections.push(toolValueSection("Output", part.state.output));
  }
  if (part.state.error !== undefined && part.state.error !== null) {
    sections.push(toolValueSection("Error", part.state.error));
  }
  if (part.state.metadata !== undefined && part.state.metadata !== null) {
    sections.push(toolValueSection("Metadata", part.state.metadata));
  }
  return sections.join("\n\n");
}

function formatImagePart(part: ImagePart): string {
  const url = part.url?.trim();
  if (url && !url.toLowerCase().startsWith("data:")) {
    const destination = url.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\n", "%0A");
    return `![Image](<${destination}>)`;
  }
  return `_Embedded image (${part.mime_type ?? "unknown type"}) omitted._`;
}

function formatMessagePart(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text.trim();
    case "reasoning": {
      const text = part.text.trim();
      return text ? `### Reasoning\n\n${text}` : "";
    }
    case "plan": {
      const text = part.text.trim();
      if (!text) return "";
      const heading = part.approval_status === "fail" ? "Rejected plan" : "Plan";
      return `### ${heading}\n\n${text}`;
    }
    case "tool":
      return formatToolPart(part);
    case "image":
      return formatImagePart(part);
  }
}

function formatMessage(message: Message): string {
  const content = message.parts.map(formatMessagePart).filter(Boolean).join("\n\n");
  if (!content) return "";
  return `## ${messageRoleLabels[message.role]}\n\n${content}`;
}

export function formatSessionAsMarkdown(session: SessionDetail): string {
  const title = getSessionDisplayTitle(session).replace(/\s+/g, " ").trim() || "Session";
  const metadata = [
    `- Agent: ${inlineCode(session.reference.agentName)}`,
    `- Session ID: ${inlineCode(session.reference.sessionId)}`,
  ];
  if (session.directory.trim()) metadata.push(`- Directory: ${inlineCode(session.directory)}`);
  const messages = session.messages.map(formatMessage).filter(Boolean);
  const content = messages.length > 0 ? messages.join("\n\n") : "_No displayable messages._";
  return [`# ${title}`, metadata.join("\n"), content].join("\n\n") + "\n";
}
