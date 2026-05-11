import type {
  FileActivityKind,
  Message,
  MessagePart,
  SessionFileActivity,
  SessionFileActivityOccurrence,
} from "../types/index.js";

interface CodexPatchEntry {
  type: string;
  path: string;
  oldPath: string;
}

function toRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toStringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeToolLabel(part: MessagePart) {
  if (typeof part.title === "string" && part.title.trim()) {
    return part.title.trim().replace(/^tool:\s*/i, "");
  }
  if (typeof part.tool === "string" && part.tool.trim()) return part.tool.trim();
  return "tool";
}

function normalizeToolName(part: MessagePart) {
  return normalizeToolLabel(part).trim().toLowerCase();
}

function looksLikeFilePath(value: string) {
  const text = value.trim();
  if (!text || text.length > 300) return false;
  if (text.includes("\n")) return false;
  if (/^[a-z]+:\/\//i.test(text)) return false;
  if (/[<>{}]/.test(text)) return false;
  if (text.startsWith("/")) return true;
  if (text.startsWith("./") || text.startsWith("../") || text.startsWith("~/")) return true;
  if (text.includes("/") || text.includes("\\")) return true;
  return /^[A-Za-z0-9_.@-]+\.[A-Za-z0-9_-]+$/.test(text);
}

function shouldTreatAsPathKey(key: string) {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes("command") ||
    normalized.includes("content") ||
    normalized.includes("text") ||
    normalized.includes("prompt") ||
    normalized.includes("url") ||
    normalized.includes("body") ||
    normalized.includes("title") ||
    normalized.includes("description") ||
    normalized === "cwd" ||
    normalized === "workdir" ||
    normalized === "directory"
  ) {
    return false;
  }
  return (
    normalized === "path" ||
    normalized === "paths" ||
    normalized.includes("file") ||
    normalized.includes("path")
  );
}

function collectPathsFromValue(
  value: unknown,
  keyHint: string,
  paths: Set<string>,
  depth = 0,
): void {
  if (value == null || depth > 4) return;

  if (typeof value === "string") {
    if (shouldTreatAsPathKey(keyHint) && looksLikeFilePath(value)) {
      paths.add(value.trim());
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathsFromValue(item, keyHint, paths, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectPathsFromValue(nested, key, paths, depth + 1);
    }
  }
}

function extractPathsFromToolInput(inputValue: unknown) {
  const paths = new Set<string>();
  collectPathsFromValue(inputValue, "", paths);
  return [...paths];
}

function getToolInputValue(part: MessagePart) {
  return part.state?.arguments ?? part.state?.input ?? part.input ?? null;
}

function classifyToolKind(part: MessagePart): FileActivityKind | null {
  const toolName = normalizeToolName(part);
  if (toolName === "read" || toolName === "readfile" || toolName === "read_file") return "read";
  if (
    toolName === "edit" ||
    toolName === "multiedit" ||
    toolName === "apply_patch" ||
    toolName === "notebookedit"
  ) {
    return "edit";
  }
  if (
    toolName === "write" ||
    toolName === "writefile" ||
    toolName === "write_file" ||
    toolName === "create_file"
  ) {
    return "write";
  }
  if (toolName === "delete" || toolName === "delete_file") {
    return "delete";
  }
  return null;
}

function normalizeCodexPatchEntry(entry: unknown): CodexPatchEntry | null {
  const record = toRecord(entry);
  const type = toStringValue(record.type);
  if (!type) return null;
  return {
    type,
    path: toStringValue(record.path),
    oldPath: toStringValue(record.old_path),
  };
}

function getCodexPatchEntries(inputValue: unknown): CodexPatchEntry[] {
  const input = toRecord(inputValue);
  const rawContent: unknown[] = Array.isArray(inputValue)
    ? inputValue
    : Array.isArray(input.content)
      ? (input.content as unknown[])
      : [];

  return rawContent
    .map((entry) => normalizeCodexPatchEntry(entry))
    .filter((entry): entry is CodexPatchEntry => entry != null);
}

function patchEntryKind(type: string): FileActivityKind {
  if (type === "write_file") return "write";
  if (type === "delete_file") return "delete";
  return "edit";
}

export function extractFileActivityOccurrences(
  messages: Message[],
): SessionFileActivityOccurrence[] {
  const occurrences: SessionFileActivityOccurrence[] = [];

  messages.forEach((message, messageIndex) => {
    let toolIndex = 0;

    for (const part of message.parts) {
      if (part.type !== "tool") continue;

      const inputValue = getToolInputValue(part);
      const toolLabel = normalizeToolLabel(part);
      const time = part.time_created ?? message.time_created;
      const currentToolIndex = toolIndex;
      toolIndex += 1;

      const patchEntries = getCodexPatchEntries(inputValue);
      if (patchEntries.length > 0) {
        for (const entry of patchEntries) {
          const path = (entry.path || entry.oldPath).trim();
          if (!path) continue;
          occurrences.push({
            path,
            kind: patchEntryKind(entry.type),
            time,
            tool_label: toolLabel,
            message_index: messageIndex,
            tool_index: currentToolIndex,
          });
        }
        continue;
      }

      const kind = classifyToolKind(part);
      if (!kind) continue;

      for (const path of extractPathsFromToolInput(inputValue)) {
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
      current.latest_time = Math.max(current.latest_time, occurrence.time);
      continue;
    }

    grouped.set(key, {
      agent_name: agentName,
      session_id: sessionId,
      project_identity_key: projectIdentityKey,
      path: occurrence.path,
      kind: occurrence.kind,
      count: 1,
      latest_time: occurrence.time,
    });
  }

  return [...grouped.values()].sort((a, b) => {
    if (b.latest_time !== a.latest_time) return b.latest_time - a.latest_time;
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
