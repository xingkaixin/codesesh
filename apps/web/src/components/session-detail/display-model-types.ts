import type { Message } from "@codesesh/contract";
import type { MessageBlock } from "./blocks";

export interface MessageDisplayModel {
  msg: Message;
  blocks: MessageBlock[];
  index: number;
}

export interface FilteredSessionMessage {
  msg: Message;
  blocks: MessageBlock[];
  index: number;
}
