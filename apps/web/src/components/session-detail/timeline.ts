import type { MessagePart } from "../../lib/api";
import { extractMessageText } from "./blocks";
import { classifyToolKind } from "./file-change";
import { normalizeToolLabel } from "./tool-normalize";
import type { FilteredSessionMessage } from "./toc";

const TIMELINE_SUMMARY_LENGTH = 48;
const TIMELINE_SCROLL_EDGE_TOLERANCE = 1;

export type SessionTimelineEntryKind =
  | "user"
  | "agent"
  | "tool-read"
  | "tool-write"
  | "tool-execute";
export type ToolTimelineEntryKind = Extract<SessionTimelineEntryKind, `tool-${string}`>;

export interface SessionTimelineEntry {
  id: string;
  kind: SessionTimelineEntryKind;
  anchorId: string;
  messageIndex: number;
  tooltip: string;
}

export interface TimelineAnchorPosition {
  index: number;
  top: number;
}

export function buildMessageTimelineAnchorId(messageIndex: number) {
  return `session-message-${messageIndex}`;
}

export function buildBlockTimelineAnchorId(messageIndex: number, blockIndex: number) {
  return `${buildMessageTimelineAnchorId(messageIndex)}-block-${blockIndex}`;
}

export function summarizeTimelineText(value: string) {
  const normalized = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/([*_])(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(normalized);
  if (characters.length <= TIMELINE_SUMMARY_LENGTH) return normalized;
  return `${characters.slice(0, TIMELINE_SUMMARY_LENGTH).join("")}…`;
}

function summarizeParts(parts: MessagePart[]) {
  return summarizeTimelineText(
    parts
      .map((part) => extractMessageText(part.text))
      .filter(Boolean)
      .join(" "),
  );
}

export function classifyTimelineToolKind(part: MessagePart): ToolTimelineEntryKind {
  const fileKind = classifyToolKind(part);
  if (fileKind === "read") return "tool-read";
  if (fileKind) return "tool-write";
  return "tool-execute";
}

const TOOL_KIND_LABEL = {
  "tool-read": "Read",
  "tool-write": "Write",
  "tool-execute": "Execute",
} as const;

export function buildSessionTimelineEntries(
  messages: FilteredSessionMessage[],
  toolAnchorIds: Map<MessagePart, string>,
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];

  for (const { msg, blocks, index: messageIndex } of messages) {
    if (msg.role === "user") {
      const anchorId = buildMessageTimelineAnchorId(messageIndex);
      const summary = summarizeParts(blocks.flatMap((block) => block.parts));
      entries.push({
        id: anchorId,
        kind: "user",
        anchorId,
        messageIndex,
        tooltip: `User · ${summary || "Message"}`,
      });
      continue;
    }

    blocks.forEach((block, blockIndex) => {
      if (block.type === "tool") {
        block.parts.forEach((part) => {
          const anchorId = toolAnchorIds.get(part);
          if (!anchorId) return;
          const kind = classifyTimelineToolKind(part);
          entries.push({
            id: anchorId,
            kind,
            anchorId,
            messageIndex,
            tooltip: `${TOOL_KIND_LABEL[kind]} · ${normalizeToolLabel(part)}`,
          });
        });
        return;
      }

      const anchorId = buildBlockTimelineAnchorId(messageIndex, blockIndex);
      const summary = summarizeParts(block.parts);
      entries.push({
        id: anchorId,
        kind: "agent",
        anchorId,
        messageIndex,
        tooltip: `Agent · ${summary || "Response"}`,
      });
    });
  }

  return entries;
}

export function findActiveTimelineIndex(
  positions: TimelineAnchorPosition[],
  viewportCenter: number,
) {
  if (positions.length === 0) return null;

  const ordered = positions.toSorted((a, b) => a.top - b.top);
  let activeIndex = ordered[0]!.index;
  for (const position of ordered) {
    if (position.top > viewportCenter) break;
    activeIndex = position.index;
  }
  return activeIndex;
}

export function findTimelineEdgeIndex(
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  entryCount: number,
) {
  if (entryCount <= 0) return null;
  if (scrollTop <= TIMELINE_SCROLL_EDGE_TOLERANCE) return 0;

  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  if (scrollTop >= maxScrollTop - TIMELINE_SCROLL_EDGE_TOLERANCE) return entryCount - 1;
  return null;
}

export function findTimelineIndexAtPointer(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  entryCount: number,
) {
  if (entryCount <= 0 || trackWidth <= 0) return null;
  const progress = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
  return Math.min(entryCount - 1, Math.floor(progress * entryCount));
}
