import type { Message } from "../../lib/api";
import { buildMessageBlocks, type MessageBlock } from "./blocks";

export interface MessageDisplayModel {
  msg: Message;
  blocks: MessageBlock[];
  index: number;
}

export function buildMessageDisplayModels(messages: Message[]): MessageDisplayModel[] {
  const models: MessageDisplayModel[] = [];

  for (const msg of messages) {
    const blocks = buildMessageBlocks(msg.parts);
    if (blocks.length === 0) continue;

    models.push({ msg, blocks, index: models.length });
  }

  return models;
}
