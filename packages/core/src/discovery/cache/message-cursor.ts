import { createHash, type Hash } from "node:crypto";
import type { SessionReference } from "../../contract/index.js";

export const MESSAGE_CURSOR_VERSION = 2;

export interface MessageCursorContent {
  messageId: string;
  role: string;
  timeCreated: number;
  timeCompleted: number | null | undefined;
  agent: string | null | undefined;
  mode: string | null | undefined;
  model: string | null | undefined;
  provider: string | null | undefined;
  tokensJson: string | null | undefined;
  cost: number | null | undefined;
  costSource: string | null | undefined;
  partsJson: string;
  partsFormatVersion: number | string | null | undefined;
  subagentId: string | null | undefined;
  nickname: string | null | undefined;
}

function updateField(hash: Hash, value: string | number | null | undefined): void {
  if (value == null) {
    hash.update("n;");
    return;
  }
  const text = String(value);
  hash.update(`v${text.length}:`).update(text).update(";");
}

function updateMessageContent(hash: Hash, content: MessageCursorContent): void {
  updateField(hash, content.messageId);
  updateField(hash, content.role);
  updateField(hash, content.timeCreated);
  updateField(hash, content.timeCompleted);
  updateField(hash, content.agent);
  updateField(hash, content.mode);
  updateField(hash, content.model);
  updateField(hash, content.provider);
  updateField(hash, content.tokensJson);
  updateField(hash, content.cost);
  updateField(hash, content.costSource);
  updateField(hash, content.partsJson);
  updateField(hash, content.partsFormatVersion);
  updateField(hash, content.subagentId);
  updateField(hash, content.nickname);
}

export function initialMessageCursorDigest(reference: SessionReference): string {
  const hash = createHash("sha256");
  hash.update("codesesh-session-messages\0");
  updateField(hash, MESSAGE_CURSOR_VERSION);
  updateField(hash, reference.agentName);
  updateField(hash, reference.sessionId);
  return hash.digest("hex");
}

export function advanceMessageCursorDigest(
  previousDigest: string,
  content: MessageCursorContent,
): string {
  const hash = createHash("sha256");
  hash.update("codesesh-session-messages-chain\0");
  updateField(hash, previousDigest);
  updateMessageContent(hash, content);
  return hash.digest("hex");
}

export function computeMessageCursorDigest(
  reference: SessionReference,
  messages: Iterable<MessageCursorContent>,
): string {
  let digest = initialMessageCursorDigest(reference);
  for (const message of messages) {
    digest = advanceMessageCursorDigest(digest, message);
  }
  return digest;
}
