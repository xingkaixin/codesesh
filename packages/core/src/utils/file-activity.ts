import type {
  Message,
  SessionFileActivity,
  SessionFileActivityOccurrence,
  ToolPart,
} from "../types/index.js";
import { extractFileToolOperations } from "../contract/file-activity.js";

function normalizeToolLabel(part: ToolPart) {
  if (part.title?.trim()) {
    return part.title.trim().replace(/^tool:\s*/i, "");
  }
  if (part.tool.trim()) return part.tool.trim();
  return "tool";
}

export function extractFileActivityOccurrences(
  messages: Message[],
): SessionFileActivityOccurrence[] {
  const occurrences: SessionFileActivityOccurrence[] = [];

  messages.forEach((message, messageIndex) => {
    let toolIndex = 0;

    for (const part of message.parts) {
      if (part.type !== "tool") continue;

      const toolLabel = normalizeToolLabel(part);
      const time = part.time_created ?? message.time_created;
      const currentToolIndex = toolIndex;
      toolIndex += 1;

      for (const { kind, path } of extractFileToolOperations(part)) {
        occurrences.push({
          path,
          kind,
          time,
          tool_label: toolLabel,
          message_index: messageIndex,
          tool_index: currentToolIndex,
        });
      }
    }
  });

  return occurrences;
}

export function summarizeFileActivity(
  agentName: string,
  sessionId: string,
  projectIdentityKey: string,
  occurrences: SessionFileActivityOccurrence[],
): SessionFileActivity[] {
  const grouped = new Map<string, SessionFileActivity>();

  for (const occurrence of occurrences) {
    const key = `${occurrence.kind}\0${occurrence.path}`;
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
      current.latestTime = Math.max(current.latestTime, occurrence.time);
      continue;
    }

    grouped.set(key, {
      reference: { agentName, sessionId },
      projectIdentityKey,
      path: occurrence.path,
      kind: occurrence.kind,
      count: 1,
      latestTime: occurrence.time,
    });
  }

  return [...grouped.values()].sort((a, b) => {
    if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime;
    return a.path.localeCompare(b.path);
  });
}

export function extractSessionFileActivity(
  agentName: string,
  sessionId: string,
  projectIdentityKey: string,
  messages: Message[],
): SessionFileActivity[] {
  return summarizeFileActivity(
    agentName,
    sessionId,
    projectIdentityKey,
    extractFileActivityOccurrences(messages),
  );
}
