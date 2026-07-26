import type { Message, SessionFileActivity } from "../../lib/api";
import { buildMessageBlocks, type MessageBlock } from "./blocks";
import {
  buildFileChangeSummary,
  buildFileChangeSummaryFromActivity,
  buildToolAnchorId,
  type FileChangeSummary,
} from "./file-change";
import { buildSessionTimelineEntries, type SessionTimelineEntry } from "./timeline";
import {
  buildSessionDetailToc,
  filterSessionMessages,
  type FilteredSessionMessage,
  type SessionDetailToc,
} from "./toc";
import { normalizeMessagesForDisplay } from "./tool-strategy";

export interface MessageDisplayModel {
  msg: Message;
  blocks: MessageBlock[];
  index: number;
}

export interface SessionDetailSelection {
  messages: FilteredSessionMessage[];
  timelineEntries: SessionTimelineEntry[];
  resolveListIndex(messageIndex: number): number | undefined;
}

export interface SessionDetailDisplayModel {
  messages: MessageDisplayModel[];
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  select(selectedFilters: Set<string>): SessionDetailSelection;
  resolveMessageIndex(anchorId: string): number | undefined;
}

function attachToolAnchors(blocks: MessageBlock[], messageIndex: number): MessageBlock[] {
  let toolIndex = 0;
  return blocks.map((block) => {
    if (block.type !== "tool") return block;
    const anchorIds = block.parts.map(() => buildToolAnchorId(messageIndex, toolIndex++));
    return { ...block, anchorIds };
  });
}

function buildMessageDisplayModels(messages: Message[]): MessageDisplayModel[] {
  const models: MessageDisplayModel[] = [];

  for (const msg of messages) {
    const blocks = buildMessageBlocks(msg.parts);
    if (blocks.length === 0) continue;

    const index = models.length;
    models.push({ msg, blocks: attachToolAnchors(blocks, index), index });
  }

  return models;
}

export function buildSessionDetailDisplayModel({
  messages,
  agentName,
  fileActivity,
}: {
  messages: Message[];
  agentName: string;
  fileActivity?: SessionFileActivity[];
}): SessionDetailDisplayModel {
  const displayMessages = buildMessageDisplayModels(
    normalizeMessagesForDisplay(messages, agentName),
  );
  const toc = buildSessionDetailToc(displayMessages);
  const fileChanges = buildFileChangeSummary(displayMessages);
  const fileChangeSummary = buildFileChangeSummaryFromActivity(fileActivity, fileChanges.summary);

  return {
    messages: displayMessages,
    toc,
    fileChangeSummary,
    select(selectedFilters) {
      const filteredMessages = filterSessionMessages(displayMessages, selectedFilters);
      const listIndexes = new Map(
        filteredMessages.map((message, listIndex) => [message.index, listIndex]),
      );
      return {
        messages: filteredMessages,
        timelineEntries: buildSessionTimelineEntries(filteredMessages),
        resolveListIndex(messageIndex) {
          return listIndexes.get(messageIndex);
        },
      };
    },
    resolveMessageIndex(anchorId) {
      return fileChanges.anchorMessageIndexes.get(anchorId);
    },
  };
}
