import type { Message } from "../../lib/api";

export const CODEX_TURN_ABORTED_TEXT = `<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec processes were terminated. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.
</turn_aborted>`;

function normalizeText(text: string) {
  return text.replace(/\r\n/g, "\n").trim();
}

export function isCodexTurnAbortedMessage(msg: Message, sessionAgentKey: string) {
  if (sessionAgentKey.toLowerCase() !== "codex" || msg.role !== "user") {
    return false;
  }

  if (msg.parts.length !== 1) {
    return false;
  }

  const [part] = msg.parts;
  if (!part || part.type !== "text") {
    return false;
  }

  return normalizeText(part.text) === normalizeText(CODEX_TURN_ABORTED_TEXT);
}
