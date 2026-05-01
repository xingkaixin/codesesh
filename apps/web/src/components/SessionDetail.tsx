/* eslint-disable react/no-array-index-key */
import { diffLines, type Change } from "diff";
import {
  Funnel,
  BookOpenText,
  Bot,
  CalendarRange,
  CircleHelp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FilePenLine,
  FileSearch,
  FileText,
  LoaderCircle,
  Lightbulb,
  MessageCircleX,
  NotebookPen,
  SquareTerminal,
  UserRound,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ModelConfig } from "../config";
import { cn } from "../lib/utils";
import type { Message, MessagePart, SessionData } from "../lib/api";
import { InteractiveReceipt } from "./InteractiveReceipt";
import { MarkdownContent } from "./MarkdownContent";
import {
  buildMessageBlocks,
  extractMessageText,
  hasVisibleContent,
  type MessageBlock,
} from "./session-detail/blocks";
import { isCodexTurnAbortedMessage } from "./session-detail/codex-abort";
import {
  buildCodexPatchOutputContent,
  getCodexPatchEntries,
  summarizeCodexPatchEntries,
} from "./session-detail/codex-patch";
import { buildCodexPlanDisplay } from "./session-detail/codex-plan";
import {
  buildCodexExecCommandDisplay,
  buildCodexRequestUserInputDisplay,
  buildCodexWriteStdinDisplay,
  type ToolDetailItem,
} from "./session-detail/codex-tool";
import {
  buildSessionDetailToc,
  filterSessionMessages,
  type SessionDetailToc,
  type TocFilterId,
} from "./session-detail/toc";
import { detectLanguageByFilePath } from "./tool-output/language";
import { ToolOutputRenderer } from "./tool-output/ToolOutputRenderer";
import type { DiffBlock, DiffLineItem, ToolOutputContent } from "./tool-output/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  session: SessionData;
  highlightQuery?: string;
}

type ToolStatus = "running" | "completed" | "error";

interface NormalizedToolState {
  status: ToolStatus;
  inputValue: unknown;
  outputValue: unknown;
  errorValue: unknown;
  metadataValue: unknown;
  inputText: string;
  command: string;
}

interface ToolDisplayStrategy {
  Icon: typeof LoaderCircle;
  title: string;
  secondaryText?: string;
  details: ToolDetailItem[];
  expandable: boolean;
  showInputPreview: boolean;
  outputContent: ToolOutputContent;
}

type FileChangeKind = "read" | "edit" | "write" | "delete";

interface FileChangeRecord {
  kind: FileChangeKind;
  path: string;
  anchorId: string;
  time: number;
  toolLabel: string;
}

interface FileChangeSummaryItem {
  path: string;
  count: number;
  latestTime: number;
  latestAnchorId: string;
  toolLabel: string;
  anchors: Array<{ anchorId: string; time: number; toolLabel: string }>;
}

interface FileChangeSummary {
  read: FileChangeSummaryItem[];
  edit: FileChangeSummaryItem[];
  write: FileChangeSummaryItem[];
  delete: FileChangeSummaryItem[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_STATUS_META: Record<
  ToolStatus,
  { label: string; className: string; icon: typeof LoaderCircle }
> = {
  completed: {
    label: "Success",
    className:
      "border-[var(--console-success-border)] bg-[var(--console-success-bg)] text-[var(--console-success)]",
    icon: CheckCircle2,
  },
  error: {
    label: "Failed",
    className:
      "border-[var(--console-error-border)] bg-[var(--console-error-bg)] text-[var(--console-error)]",
    icon: XCircle,
  },
  running: {
    label: "Running",
    className:
      "border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] text-[var(--console-warning)]",
    icon: LoaderCircle,
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightPattern(query?: string): RegExp | null {
  const normalized = query?.trim();
  if (!normalized) return null;
  const terms = Array.from(
    new Set(
      (normalized.match(/"[^"]+"|\S+/g) ?? [])
        .map((term) => term.replace(/^"|"$/g, "").trim())
        .filter(Boolean)
        .filter((term) => !/^OR$/i.test(term)),
    ),
  );
  if (terms.length === 0) return null;
  return new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
}

function renderHighlightedText(text: string, query?: string) {
  const pattern = buildHighlightPattern(query);
  if (!pattern) return text;

  const parts = text.split(pattern);
  return parts.map((part, index) =>
    part.match(pattern) ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

function MessageMarkdown({ text, highlightQuery }: { text: string; highlightQuery?: string }) {
  return <MarkdownContent text={text} highlightQuery={highlightQuery} />;
}

function toDisplayText(value: unknown) {
  if (value == null) return "";

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return `${value}`;
    }
    if (typeof value === "symbol") {
      return value.description ? `Symbol(${value.description})` : "Symbol";
    }
    if (typeof value === "function") return "[Function]";
    return "[Unserializable value]";
  }
}

function parseInputCandidate(inputValue: unknown) {
  if (typeof inputValue !== "string") return inputValue;
  try {
    return JSON.parse(inputValue) as unknown;
  } catch {
    return inputValue;
  }
}

function extractToolTextSegments(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => extractToolTextSegments(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return [record.text];
    if (record.content !== undefined) return extractToolTextSegments(record.content);
  }
  return [];
}

function stripSystemTag(text: string) {
  return text
    .replace(/^<system>/i, "")
    .replace(/<\/system>$/i, "")
    .trim();
}

function joinToolText(value: unknown, includeSystem = true) {
  const segments = extractToolTextSegments(value)
    .map((segment) => segment.trim())
    .filter((segment) => {
      if (includeSystem) return Boolean(segment);
      return Boolean(segment) && !/^<system>[\s\S]*<\/system>$/i.test(segment);
    });

  if (segments.length === 0) return "";

  return segments
    .map((segment) =>
      includeSystem && /^<system>[\s\S]*<\/system>$/i.test(segment)
        ? stripSystemTag(segment)
        : segment,
    )
    .join("\n");
}

function extractCommand(inputValue: unknown) {
  const parsed = parseInputCandidate(inputValue);
  if (parsed && typeof parsed === "object") {
    const input = parsed as { cmd?: unknown; command?: unknown };
    if (typeof input.cmd === "string") return input.cmd;
    if (typeof input.command === "string") return input.command;
  }
  return "";
}

function compactText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toPlainText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

function buildToolAnchorId(messageIndex: number, toolIndex: number) {
  return `tool-${messageIndex}-${toolIndex}`;
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

function classifyToolKind(part: MessagePart): FileChangeKind | null {
  const toolName = normalizeToolName(part);
  if (toolName === "read") return "read";
  if (
    toolName === "edit" ||
    toolName === "multiedit" ||
    toolName === "apply_patch" ||
    toolName === "notebookedit"
  ) {
    return "edit";
  }
  if (toolName === "write" || toolName === "create_file" || toolName === "write_file") {
    return "write";
  }
  if (toolName === "delete" || toolName === "delete_file") {
    return "delete";
  }
  return null;
}

function summarizeFileChangeItems(records: FileChangeRecord[]): FileChangeSummaryItem[] {
  const grouped = new Map<string, FileChangeSummaryItem>();

  for (const record of records) {
    const current = grouped.get(record.path);
    if (current) {
      current.count += 1;
      current.anchors.push({
        anchorId: record.anchorId,
        time: record.time,
        toolLabel: record.toolLabel,
      });
      if (record.time >= current.latestTime) {
        current.latestTime = record.time;
        current.latestAnchorId = record.anchorId;
        current.toolLabel = record.toolLabel;
      }
      continue;
    }

    grouped.set(record.path, {
      path: record.path,
      count: 1,
      latestTime: record.time,
      latestAnchorId: record.anchorId,
      toolLabel: record.toolLabel,
      anchors: [{ anchorId: record.anchorId, time: record.time, toolLabel: record.toolLabel }],
    });
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      anchors: item.anchors.toSorted((a, b) => a.time - b.time),
    }))
    .toSorted((a, b) => {
      if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime;
      return a.path.localeCompare(b.path);
    });
}

function buildFileChangeSummary(messages: Message[]): {
  toolAnchorIds: Map<MessagePart, string>;
  summary: FileChangeSummary;
} {
  const toolAnchorIds = new Map<MessagePart, string>();
  const fileChanges: Record<FileChangeKind, FileChangeRecord[]> = {
    read: [],
    edit: [],
    write: [],
    delete: [],
  };

  messages.forEach((message, messageIndex) => {
    let toolIndex = 0;

    for (const part of message.parts) {
      if (part.type !== "tool") continue;

      const anchorId = buildToolAnchorId(messageIndex, toolIndex);
      toolIndex += 1;
      toolAnchorIds.set(part, anchorId);

      const inputValue = getToolInputValue(part);
      const toolLabel = normalizeToolLabel(part);
      const time = part.time_created ?? message.time_created;

      const patchEntries = getCodexPatchEntries(inputValue);
      if (patchEntries.length > 0) {
        for (const entry of patchEntries) {
          const path = (entry.path || entry.oldPath).trim();
          if (!path) continue;

          const kind =
            entry.type === "write_file"
              ? "write"
              : entry.type === "delete_file"
                ? "delete"
                : "edit";
          fileChanges[kind].push({ kind, path, anchorId, time, toolLabel });
        }
        continue;
      }

      const kind = classifyToolKind(part);
      if (!kind) continue;

      const paths = extractPathsFromToolInput(inputValue);
      for (const path of paths) {
        fileChanges[kind].push({ kind, path, anchorId, time, toolLabel });
      }
    }
  });

  return {
    toolAnchorIds,
    summary: {
      read: summarizeFileChangeItems(fileChanges.read),
      edit: summarizeFileChangeItems(fileChanges.edit),
      write: summarizeFileChangeItems(fileChanges.write),
      delete: summarizeFileChangeItems(fileChanges.delete),
    },
  };
}

function formatTrackedPath(path: string, baseDirectory: string) {
  if (path.startsWith(`${baseDirectory}/`)) {
    return path.slice(baseDirectory.length + 1);
  }
  return path;
}

function scrollToToolAnchor(anchorId: string) {
  if (typeof document === "undefined") return;
  const element = document.getElementById(anchorId);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

function parseJsonText<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeEscapedNewlines(text: string) {
  return text.replace(/\\n/g, "\n");
}

function cleanToolTitle(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^tool:\s*/i, "");
}

function getToolTitle(tool: MessagePart, fallback = "Tool") {
  return cleanToolTitle(toPlainText(tool.title)) || toPlainText(tool.tool) || fallback;
}

function formatToolOutput(value: unknown) {
  const structuredText = joinToolText(value);
  const text = structuredText || toDisplayText(value);
  const normalized = normalizeEscapedNewlines(text);
  return normalized || "No output captured.";
}

function getOutputOrErrorText(state: NormalizedToolState) {
  const outputText = formatToolOutput(state.outputValue);
  if (outputText !== "No output captured.") return outputText;
  const errorText = formatToolOutput(state.errorValue);
  if (errorText !== "No output captured.") return errorText;
  return "No output captured.";
}

function getFilePathFromInput(inputValue: unknown) {
  const input = toRecord(inputValue);
  const filePath =
    toPlainText(input.filePath) ||
    toPlainText(input.file_path) ||
    toPlainText(input.path) ||
    toPlainText(input.targetFile) ||
    toPlainText(input.effectiveUri) ||
    toPlainText(input.relativeWorkspacePath);
  return filePath || "";
}

function getCursorOutputRecord(rawOutput: unknown) {
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    return rawOutput as Record<string, unknown>;
  }
  if (typeof rawOutput === "string") {
    return parseJsonText<Record<string, unknown>>(rawOutput) || {};
  }
  return {};
}

function stripClaudeReadNoise(text: string) {
  return text.replace(/\n*<system-reminder>[\s\S]*$/i, "").trimEnd();
}

function extractReadContent(rawOutput: unknown) {
  const rawText = joinToolText(rawOutput, false) || formatToolOutput(rawOutput);
  if (rawText === "No output captured.") return rawText;

  const withoutWrapper = stripClaudeReadNoise(
    rawText.replace(/^<file>\s*/i, "").replace(/\s*<\/file>\s*$/i, ""),
  );
  const lines = withoutWrapper
    .split("\n")
    .filter((line) => !/^\(End of file - total \d+ lines\)$/.test(line.trim()))
    .map((line) => line.replace(/^\d+\|\s?/, "").replace(/^\s*\d+\t/, ""));
  const cleaned = lines.join("\n").trimEnd();
  return cleaned || "No output captured.";
}

function extractCursorReadContent(rawOutput: unknown) {
  const output = getCursorOutputRecord(rawOutput);
  const contents = toStringValue(output.contents);
  if (contents) return normalizeEscapedNewlines(contents);
  return "No output captured.";
}

function formatCursorSearchOutput(rawOutput: unknown) {
  const output = getCursorOutputRecord(rawOutput);
  const directories = Array.isArray(output.directories) ? output.directories : [];
  if (directories.length === 0) return formatToolOutput(rawOutput);

  const lines = directories.flatMap((entry) => {
    const record = toRecord(entry);
    const directoryPath = toPlainText(record.absPath);
    const files = Array.isArray(record.files) ? record.files : [];
    const fileLines = files
      .map((file) => {
        const fileRecord = toRecord(file);
        return toPlainText(fileRecord.relPath) || toPlainText(fileRecord.absPath);
      })
      .filter(Boolean);
    return [directoryPath, ...fileLines.map((file) => `  ${file}`)].filter(Boolean);
  });

  return lines.length > 0 ? lines.join("\n") : "No output captured.";
}

function buildStructuredDiffFromTexts(
  filePath: string,
  oldValue: string,
  newValue: string,
): DiffBlock[] {
  if (!oldValue.trim() && !newValue.trim()) return [];
  return [
    {
      label: getDiffBlockLabel(filePath),
      lines: diffPartsToLines(
        diffLines(normalizeEscapedNewlines(oldValue), normalizeEscapedNewlines(newValue)),
      ),
    },
  ];
}

function createDiffBlock(oldValue: string, newValue: string) {
  const oldLines = normalizeEscapedNewlines(oldValue).split("\n");
  const newLines = normalizeEscapedNewlines(newValue).split("\n");
  const diffLines = [
    "@@",
    ...oldLines.map((line) => `- ${line}`),
    ...newLines.map((line) => `+ ${line}`),
  ];
  return diffLines.join("\n");
}

function splitDiffChunkLines(value: string) {
  const normalized = normalizeEscapedNewlines(value);
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function diffPartsToLines(parts: Change[]): DiffLineItem[] {
  return parts.flatMap((part) => {
    const type: DiffLineItem["type"] = part.added ? "add" : part.removed ? "remove" : "context";
    return splitDiffChunkLines(part.value).map((line) => ({ type, text: line }));
  });
}

function getKimiEditEntries(inputValue: unknown) {
  const input = toRecord(inputValue);
  const rawEdit = input.edit;
  if (Array.isArray(rawEdit)) return rawEdit;
  if (rawEdit && typeof rawEdit === "object") return [rawEdit];
  return [];
}

function getDiffBlockLabel(filePath: string) {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) return "edit";
  const fileName = normalizedPath.split("/").pop() || normalizedPath;
  return fileName === normalizedPath ? fileName : `${fileName} · ${normalizedPath}`;
}

function buildKimiEditDiffBlocks(state: NormalizedToolState, filePath: string): DiffBlock[] {
  const edits = getKimiEditEntries(state.inputValue);
  const label = getDiffBlockLabel(filePath);

  return edits
    .map((entry) => {
      const edit = toRecord(entry);
      const oldValue = toStringValue(edit.old);
      const newValue = toStringValue(edit.new);
      if (!oldValue.trim() && !newValue.trim()) return null;
      return {
        label,
        lines: diffPartsToLines(
          diffLines(normalizeEscapedNewlines(oldValue), normalizeEscapedNewlines(newValue)),
        ),
      };
    })
    .filter((block): block is DiffBlock => block != null && block.lines.length > 0);
}

function extractEditDiff(state: NormalizedToolState) {
  const metadata = toRecord(state.metadataValue);
  const diffText = toStringValue(metadata.diff);
  if (diffText.trim()) return normalizeEscapedNewlines(diffText);

  const edits = getKimiEditEntries(state.inputValue);
  const generatedDiff = edits
    .map((entry) => {
      const edit = toRecord(entry);
      const oldValue = toStringValue(edit.old);
      const newValue = toStringValue(edit.new);
      if (!oldValue.trim() && !newValue.trim()) return "";
      return createDiffBlock(oldValue, newValue);
    })
    .filter(Boolean)
    .join("\n\n");
  if (generatedDiff.trim()) return generatedDiff;

  return getOutputOrErrorText(state);
}

function extractWriteContent(state: NormalizedToolState) {
  const input = toRecord(state.inputValue);
  if (state.status === "completed") {
    const contentText = toStringValue(input.content);
    if (contentText.trim()) return normalizeEscapedNewlines(contentText);
  }
  return getOutputOrErrorText(state);
}

// ---------------------------------------------------------------------------
// Subagent helpers
// ---------------------------------------------------------------------------

function getSubagentToolTitle(part: MessagePart) {
  const state = toRecord(part.state);
  const argumentsValue = toRecord(state.arguments);
  const agentType = compactText(argumentsValue.agent_type);
  const nickname = compactText((part as { nickname?: unknown }).nickname);
  const model = compactText(argumentsValue.model);
  const reasoningEffort = compactText(argumentsValue.reasoning_effort);
  const modelSuffix = [model, reasoningEffort].filter(Boolean).join("-");
  const left = [agentType, nickname].filter(Boolean).join(" - ");
  return [left, modelSuffix].filter(Boolean).join(" ");
}

function getSubagentPrompt(part: MessagePart) {
  const state = toRecord(part.state);
  const prompt = compactText(state.prompt);
  if (prompt) return prompt;

  const argumentsValue = toRecord(state.arguments);
  const message = compactText(argumentsValue.message);
  if (message) return message;

  return "";
}

function getAssistantDisplayLabel(msg: Message) {
  const nickname = compactText(msg.nickname);
  if (msg.role === "assistant" && nickname) return `AGENT (${nickname})`;
  if (msg.role === "user") return "USER";
  if (msg.role === "tool") return "TOOL";
  return "AGENT";
}

function normalizeMessagesForDisplay(messages: Message[], sessionAgentKey: string) {
  if (sessionAgentKey.toLowerCase() !== "cursor") return messages;

  const normalized: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool") {
      normalized.push({ ...msg, parts: [...msg.parts] });
      continue;
    }
    const previous = normalized.at(-1);
    if (previous?.role === "assistant") {
      previous.parts.push(...msg.parts);
      continue;
    }
    normalized.push({ ...msg, parts: [...msg.parts] });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Tool state normalization
// ---------------------------------------------------------------------------

function normalizeToolState(part: MessagePart): NormalizedToolState {
  const rawState = (part.state || {}) as Record<string, unknown>;
  const rawStatus = rawState.status;
  const status: ToolStatus =
    rawStatus === "running" || rawStatus === "error" || rawStatus === "completed"
      ? rawStatus
      : "completed";

  const outputValue = rawState.output ?? rawState.result ?? "";
  const errorValue = rawState.error ?? "";
  const inputValue = parseInputCandidate(rawState.input ?? rawState.arguments ?? {});
  const metadataValue = rawState.metadata ?? {};
  const command = extractCommand(inputValue);

  return {
    status,
    command,
    inputValue,
    outputValue,
    errorValue,
    metadataValue,
    inputText: toDisplayText(inputValue),
  };
}

// ---------------------------------------------------------------------------
// Tool display strategies
// ---------------------------------------------------------------------------

function buildDefaultToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const preview = state.command || state.inputText || "{}";
  const compactPreview = preview.replace(/\s+/g, " ").trim();
  const previewText =
    compactPreview.length > 72 ? `${compactPreview.slice(0, 72)}...` : compactPreview;

  return {
    Icon: SquareTerminal,
    title: getToolTitle(tool),
    secondaryText: previewText ? `(${previewText})` : undefined,
    details: [],
    expandable: true,
    showInputPreview: true,
    outputContent: {
      kind: "plain",
      text: getOutputOrErrorText(state),
      language: "text",
      isCode: false,
    },
  };
}

function buildSkillToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
): ToolDisplayStrategy {
  const input = toRecord(state.inputValue);
  const name = toPlainText(input.name);

  return {
    ...defaultStrategy,
    Icon: Wrench,
    title: toPlainText(tool.tool) || "skill",
    secondaryText: name || undefined,
    expandable: false,
    showInputPreview: false,
  };
}

function buildClaudeToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);

  if (toolKey === "read") {
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: "read",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractReadContent(state.outputValue),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  if (toolKey === "edit") {
    const oldValue = toStringValue(input.old_string);
    const newValue = toStringValue(input.new_string);
    const diffBlocks = buildStructuredDiffFromTexts(filePath, oldValue, newValue);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
    };
  }

  if (toolKey === "write") {
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: "write",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  return { ...defaultStrategy, title: getToolTitle(tool) };
}

function buildOpencodeToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);

  if (toolKey === "glob") {
    const pattern = toPlainText(input.pattern);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.tool || "glob",
      secondaryText: pattern || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "grep") {
    const path = toPlainText(input.path);
    const pattern = toPlainText(input.pattern);
    const details = [path, pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.tool || "grep",
      secondaryText: details || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "bash") {
    const description = toPlainText(input.description);
    const command = toPlainText(input.command);
    const secondaryText = description
      ? `${description}${command ? ` (${command})` : ""}`
      : command
        ? `(${command})`
        : undefined;
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: tool.tool || "bash",
      secondaryText,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "read") {
    const filePath = getFilePathFromInput(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: tool.tool || "read",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractReadContent(state.outputValue),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  if (toolKey === "edit") {
    const filePath = getFilePathFromInput(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: tool.tool || "edit",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractEditDiff(state),
        language: "diff",
        isCode: true,
      },
    };
  }

  if (toolKey === "write") {
    const filePath = getFilePathFromInput(state.inputValue);
    const isSuccessfulWrite = state.status === "completed";
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: tool.tool || "write",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: isSuccessfulWrite,
      },
    };
  }

  if (toolKey === "skill") {
    return buildSkillToolStrategy(tool, state, defaultStrategy);
  }

  return defaultStrategy;
}

function buildKimiToolStrategy(tool: MessagePart, state: NormalizedToolState): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);

  if (toolKey === "glob") {
    const pattern = toPlainText(input.pattern);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.title || "glob",
      secondaryText: pattern || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "grep") {
    const path = toPlainText(input.path);
    const pattern = toPlainText(input.pattern);
    const details = [path, pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.title || "grep",
      secondaryText: details || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "shell") {
    const command = toPlainText(input.command);
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: tool.title || "bash",
      secondaryText: command ? `(${command})` : undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "readfile") {
    const filePath = getFilePathFromInput(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: tool.title || "read",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractReadContent(state.outputValue),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  if (toolKey === "strreplacefile") {
    const filePath = getFilePathFromInput(state.inputValue);
    const diffBlocks = buildKimiEditDiffBlocks(state, filePath);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: tool.title || "edit",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: extractEditDiff(state), language: "diff", isCode: true },
    };
  }

  if (toolKey === "writefile") {
    const filePath = getFilePathFromInput(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: tool.title || "write",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: state.status === "completed",
      },
    };
  }

  return defaultStrategy;
}

function buildCodexToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state);
  const toolKey = (tool.tool || "").toLowerCase();

  if (toolKey === "skill") {
    return buildSkillToolStrategy(tool, state, defaultStrategy);
  }

  if (toolKey === "exec_command") {
    const display = buildCodexExecCommandDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
      detectLanguageByFilePath,
    );
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: display.outputAnalysis.text,
        language: display.outputAnalysis.language,
        isCode: display.outputAnalysis.isCode,
      },
    };
  }

  if (toolKey === "write_stdin") {
    const display = buildCodexWriteStdinDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
      detectLanguageByFilePath,
    );
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: display.outputAnalysis.text,
        language: display.outputAnalysis.language,
        isCode: display.outputAnalysis.isCode,
      },
    };
  }

  if (toolKey === "request_user_input") {
    const display = buildCodexRequestUserInputDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
    );
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      title: "ask",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: display.outputContent,
    };
  }

  if (toolKey === "patch") {
    const entries = getCodexPatchEntries(state.inputValue);
    const summary = summarizeCodexPatchEntries(entries);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: getToolTitle(tool, "patch"),
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: false,
      outputContent: buildCodexPatchOutputContent(
        entries,
        getOutputOrErrorText(state),
        detectLanguageByFilePath,
      ),
    };
  }

  if (toolKey === "subagent") {
    const prompt = getSubagentPrompt(tool);
    const fallbackText = getOutputOrErrorText(state);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: getSubagentToolTitle(tool) || getToolTitle(tool, "subagent"),
      secondaryText: undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: prompt || fallbackText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  return defaultStrategy;
}

function buildCursorToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);

  if (toolKey === "read_file_v2") {
    const content = extractCursorReadContent(state.outputValue);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: "read",
      secondaryText: filePath || undefined,
      details:
        content === "No output captured."
          ? [
              {
                label: "Lines",
                value: toPlainText(getCursorOutputRecord(state.outputValue).totalLinesInFile),
              },
            ]
          : [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: content,
        language: detectLanguageByFilePath(filePath),
        isCode: content !== "No output captured.",
      },
    };
  }

  if (toolKey === "edit_file_v2") {
    const diffText = normalizeEscapedNewlines(toStringValue(input.streamingContent));
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: filePath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: diffText || getOutputOrErrorText(state),
        language: diffText ? "diff" : "text",
        isCode: Boolean(diffText),
      },
    };
  }

  if (toolKey === "ripgrep_raw_search") {
    const pattern = toPlainText(input.pattern);
    const path = toPlainText(input.path);
    const summary = [path, pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: "grep",
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "glob_file_search") {
    const pattern = toPlainText(input.globPattern);
    const targetDirectory = toPlainText(input.targetDirectory);
    const summary = [targetDirectory, pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: "glob",
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: formatCursorSearchOutput(state.outputValue),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "run_terminal_command_v2") {
    const command = toPlainText(input.command);
    const description = toPlainText(input.commandDescription);
    const secondaryText = description
      ? `${description}${command ? ` (${command})` : ""}`
      : command
        ? `(${command})`
        : undefined;
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  return { ...defaultStrategy, title: getToolTitle(tool) };
}

function getToolDisplayStrategy(
  sessionAgentKey: string,
  tool: MessagePart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const normalizedAgentKey = sessionAgentKey.toLowerCase();
  if (normalizedAgentKey === "opencode") return buildOpencodeToolStrategy(tool, state);
  if (normalizedAgentKey === "codex") return buildCodexToolStrategy(tool, state);
  if (normalizedAgentKey === "kimi") return buildKimiToolStrategy(tool, state);
  if (normalizedAgentKey === "claudecode") return buildClaudeToolStrategy(tool, state);
  if (normalizedAgentKey === "cursor") return buildCursorToolStrategy(tool, state);
  return buildDefaultToolStrategy(tool, state);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatMessageTime(rawTime: number | string) {
  if (typeof rawTime === "number" && rawTime <= 0) return "Unknown time";

  let date: Date | null = null;
  if (typeof rawTime === "number") {
    const normalized = rawTime < 10 ** 12 ? rawTime * 1000 : rawTime;
    date = new Date(normalized);
  } else if (typeof rawTime === "string") {
    if (rawTime.trim()) {
      const timestamp = Number(rawTime);
      if (!Number.isNaN(timestamp) && timestamp > 0) {
        date = new Date(timestamp < 10 ** 12 ? timestamp * 1000 : timestamp);
      } else {
        date = new Date(rawTime);
      }
    }
  }

  if (!date || Number.isNaN(date.getTime())) return "Unknown time";

  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

// ---------------------------------------------------------------------------
// SessionDetail (main export)
// ---------------------------------------------------------------------------

export function SessionDetail({ session, highlightQuery }: SessionDetailProps) {
  const sessionSlug = session.slug || "";
  const sessionAgentKey =
    sessionSlug.split("/")[0] || ModelConfig.getDefaultAgentKey() || "claudecode";
  const normalizedMessages = useMemo(
    () => normalizeMessagesForDisplay(session.messages, sessionAgentKey),
    [session.messages, sessionAgentKey],
  );
  const visibleMessages = useMemo(
    () => normalizedMessages.filter((msg) => hasVisibleContent(msg)),
    [normalizedMessages],
  );
  const { toolAnchorIds, summary: fileChangeSummary } = useMemo(
    () => buildFileChangeSummary(visibleMessages),
    [visibleMessages],
  );
  const toc = useMemo(() => buildSessionDetailToc(visibleMessages), [visibleMessages]);
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(() => new Set(toc.filterIds));
  const tocSignature = useMemo(() => [...toc.filterIds].toSorted().join("|"), [toc.filterIds]);
  const filteredMessages = useMemo(
    () => filterSessionMessages(visibleMessages, selectedFilters),
    [visibleMessages, selectedFilters],
  );

  useEffect(() => {
    setSelectedFilters(new Set(toc.filterIds));
  }, [tocSignature, toc.filterIds]);

  if (visibleMessages.length === 0) {
    return (
      <div className="mx-auto max-w-4xl rounded-sm border border-[var(--console-border)] bg-white p-6 text-sm text-[var(--console-muted)]">
        当前会话暂无可展示的消息内容。
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-8 px-2 md:px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <SessionSummarySection
        summary={typeof session.summary_files === "string" ? session.summary_files : undefined}
      />
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_320px] lg:items-start">
        <SessionToc
          toc={toc}
          fileChangeSummary={fileChangeSummary}
          baseDirectory={session.directory}
          selectedFilters={selectedFilters}
          onToggle={(filterId) =>
            setSelectedFilters((current) => {
              const next = new Set(current);
              if (next.has(filterId)) {
                next.delete(filterId);
              } else {
                next.add(filterId);
              }
              return next;
            })
          }
        />
        <div className="flex min-w-0 flex-col gap-8">
          {filteredMessages.length > 0 ? (
            filteredMessages.map(({ msg, blocks }, index) => (
              <MessageItem
                key={index}
                msg={msg}
                blocks={blocks}
                toolAnchorIds={toolAnchorIds}
                formatTokens={formatTokens}
                sessionAgentKey={sessionAgentKey}
                highlightQuery={highlightQuery}
              />
            ))
          ) : (
            <div className="rounded-sm border border-[var(--console-border)] bg-white p-6 text-sm text-[var(--console-muted)]">
              当前筛选条件下暂无可展示的消息内容。
            </div>
          )}
        </div>
        <InteractiveReceipt session={session} toc={toc} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionToc
// ---------------------------------------------------------------------------

const TOC_META: Array<{ id: TocFilterId; label: string }> = [
  { id: "user", label: "User" },
  { id: "agent_message", label: "Agent Responses" },
  { id: "thinking", label: "Thinking" },
  { id: "plan", label: "Plans" },
  { id: "tools_all", label: "Tools" },
];

function SessionToc({
  toc,
  fileChangeSummary,
  baseDirectory,
  selectedFilters,
  onToggle,
}: {
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  selectedFilters: Set<string>;
  onToggle: (filterId: string) => void;
}) {
  const toolsEnabled = selectedFilters.has("tools_all");

  return (
    <aside className="console-scrollbar lg:sticky lg:top-4 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto lg:overscroll-contain">
      <div className="space-y-4">
        <div className="rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-3">
            <Funnel className="size-3.5 text-[var(--console-accent)]" />
            <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
              Session TOC
            </span>
          </div>
          <div className="space-y-1 p-3">
            {TOC_META.filter(({ id }) => toc.counts[id] > 0).map(({ id, label }) => (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                <input
                  type="checkbox"
                  checked={selectedFilters.has(id)}
                  onChange={() => onToggle(id)}
                  className="size-3.5 rounded border-[var(--console-border-strong)] accent-[var(--console-accent-strong)]"
                />
                <span className="console-mono min-w-0 flex-1 text-xs text-[var(--console-text)]">
                  {label}
                </span>
                <span className="console-mono text-[11px] text-[var(--console-muted)]">
                  {toc.counts[id]}
                </span>
              </label>
            ))}
            {toc.tools.length > 0 ? (
              <div className="space-y-1 border-t border-[var(--console-border)] pt-2">
                {toc.tools.map((tool) => (
                  <label
                    key={tool.id}
                    className={cn(
                      "flex items-center gap-3 rounded-sm px-2 py-2 transition-colors",
                      toolsEnabled
                        ? "cursor-pointer hover:bg-[var(--console-surface-muted)]"
                        : "cursor-not-allowed opacity-50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={toolsEnabled && selectedFilters.has(tool.id)}
                      disabled={!toolsEnabled}
                      onChange={() => onToggle(tool.id)}
                      className="size-3.5 rounded border-[var(--console-border-strong)] accent-[var(--console-accent-strong)]"
                    />
                    <span className="console-mono min-w-0 flex-1 text-xs text-[var(--console-muted)]">
                      {tool.label}
                    </span>
                    <span className="console-mono text-[11px] text-[var(--console-muted)]">
                      {tool.count}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <FileChangeTracker summary={fileChangeSummary} baseDirectory={baseDirectory} />
      </div>
    </aside>
  );
}

function FileChangeTracker({
  summary,
  baseDirectory,
}: {
  summary: FileChangeSummary;
  baseDirectory: string;
}) {
  const sections = [
    { key: "read" as const, label: "Read", Icon: FileSearch, items: summary.read },
    { key: "edit" as const, label: "Edit", Icon: FilePenLine, items: summary.edit },
    { key: "write" as const, label: "Write", Icon: NotebookPen, items: summary.write },
    { key: "delete" as const, label: "Delete", Icon: XCircle, items: summary.delete },
  ].filter((section) => section.items.length > 0) satisfies Array<{
    key: FileChangeKind;
    label: string;
    Icon: typeof LoaderCircle;
    items: FileChangeSummaryItem[];
  }>;

  if (sections.length === 0) return null;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-3">
        <FileText className="size-3.5 text-[var(--console-accent)]" />
        <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          File Tracker
        </span>
      </div>
      <div className="space-y-3 p-3">
        {sections.map(({ key, label, Icon, items }) => (
          <FileTrackerSection
            key={key}
            label={label}
            Icon={Icon}
            items={items}
            baseDirectory={baseDirectory}
          />
        ))}
      </div>
    </div>
  );
}

function FileTrackerSection({
  label,
  Icon,
  items,
  baseDirectory,
}: {
  label: string;
  Icon: typeof LoaderCircle;
  items: FileChangeSummaryItem[];
  baseDirectory: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[#fafafa]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--console-surface-muted)]"
      >
        <Icon className="size-3.5 shrink-0 text-[var(--console-accent)]" />
        <span className="console-mono min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--console-muted)]">
          {label}
        </span>
        <span className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]">
          {items.length}
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 shrink-0 text-[var(--console-muted)]" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-[var(--console-muted)]" />
        )}
      </button>
      {expanded ? (
        <div className="space-y-1 border-t border-[var(--console-border)] p-2">
          {items.map((item) => (
            <FileTrackerItem
              key={`${item.path}:${item.latestAnchorId}`}
              item={item}
              baseDirectory={baseDirectory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileTrackerItem({
  item,
  baseDirectory,
}: {
  item: FileChangeSummaryItem;
  baseDirectory: string;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);

  function jumpToIndex(nextIndex: number) {
    const total = item.anchors.length;
    if (total === 0) return;
    const normalizedIndex = ((nextIndex % total) + total) % total;
    setCurrentIndex(normalizedIndex);
    const anchor = item.anchors[normalizedIndex];
    if (anchor) {
      scrollToToolAnchor(anchor.anchorId);
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-sm px-2 py-2 transition-colors hover:bg-[var(--console-surface-muted)]">
      <button
        type="button"
        title={item.path}
        onClick={() => jumpToIndex(currentIndex)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="console-mono block break-all text-xs text-[var(--console-text)]">
          {formatTrackedPath(item.path, baseDirectory)}
        </span>
      </button>
      {item.anchors.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Previous ${item.path}`}
            onClick={() => jumpToIndex(currentIndex - 1)}
            className="rounded-sm border border-[var(--console-border)] p-1 text-[var(--console-muted)] transition-colors hover:bg-white"
          >
            <ChevronUp className="size-3" />
          </button>
          <span className="console-mono text-[10px] text-[var(--console-muted)]">
            {currentIndex + 1}/{item.anchors.length}
          </span>
          <button
            type="button"
            aria-label={`Next ${item.path}`}
            onClick={() => jumpToIndex(currentIndex + 1)}
            className="rounded-sm border border-[var(--console-border)] p-1 text-[var(--console-muted)] transition-colors hover:bg-white"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Jump to tool call"
          onClick={() => jumpToIndex(0)}
          className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]"
        >
          {item.count}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionSummarySection
// ---------------------------------------------------------------------------

export function SessionSummarySection({
  summary,
  defaultExpanded = false,
}: {
  summary?: string;
  defaultExpanded?: boolean;
}) {
  const content = typeof summary === "string" ? summary.trim() : "";
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!content) return null;

  return (
    <section className="rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="console-mono inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          <FileText className="size-3.5 text-[var(--console-accent)]" />
          Session Summary
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 text-[var(--console-muted)]" />
        ) : (
          <ChevronDown className="size-3.5 text-[var(--console-muted)]" />
        )}
      </button>
      {expanded ? (
        <div className="border-t border-[var(--console-border)] px-4 py-4">
          <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
            <MarkdownContent text={content} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// MessageItem
// ---------------------------------------------------------------------------

function MessageItem({
  msg,
  blocks,
  toolAnchorIds,
  formatTokens: fmtTokens,
  sessionAgentKey,
  highlightQuery,
}: {
  msg: Message;
  blocks?: MessageBlock[];
  toolAnchorIds: Map<MessagePart, string>;
  formatTokens: (n: number) => string;
  sessionAgentKey: string;
  highlightQuery?: string;
}) {
  const isUser = msg.role === "user";
  const isAbortMessage = isCodexTurnAbortedMessage(msg, sessionAgentKey);
  const renderedBlocks = blocks || buildMessageBlocks(msg.parts);

  const getAgentAvatar = () => {
    const agentKey = sessionAgentKey.toLowerCase();
    const agentName = ModelConfig.getAgentName(agentKey);
    const agentIcon = ModelConfig.agents[agentKey]?.icon;
    return (
      <>
        {agentIcon ? (
          <img src={agentIcon} alt={agentName} className="size-4 rounded-sm object-cover" />
        ) : (
          <Bot className="size-4 text-[var(--console-muted)]" />
        )}
      </>
    );
  };

  const modeLabel = msg.mode ? msg.mode.toUpperCase() : null;
  const modelLabel = msg.model || null;
  const roleLabel = getAssistantDisplayLabel(msg);
  const time = formatMessageTime(msg.time_created);

  return (
    <article className="w-full border-l-2 border-[var(--console-thread)] pl-4 pr-3 md:pr-5">
      <div className="flex gap-4">
        <div className="shrink-0 pt-1">
          <div className="flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
            {isUser ? (
              <UserRound className="size-4 text-[var(--console-muted)]" />
            ) : (
              getAgentAvatar()
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="console-mono text-sm font-bold tracking-wide text-[var(--console-text)]">
              {roleLabel}
            </span>
            <time className="console-mono text-xs text-[var(--console-muted)]">{time}</time>
            {modeLabel && (
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                {modeLabel}
              </span>
            )}
            {modelLabel && (
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                {modelLabel}
              </span>
            )}
          </div>

          {isAbortMessage ? (
            <AbortToolItem />
          ) : (
            renderedBlocks.map((block, index) => {
              if (block.type === "reasoning") {
                return (
                  <ReasoningSection
                    key={index}
                    parts={block.parts}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              if (block.type === "plan") {
                return (
                  <PlansSection key={index} parts={block.parts} highlightQuery={highlightQuery} />
                );
              }
              if (block.type === "tool") {
                return (
                  <ToolsSection
                    key={index}
                    parts={block.parts}
                    toolAnchorIds={toolAnchorIds}
                    sessionAgentKey={sessionAgentKey}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              return (
                <div
                  key={index}
                  className="rounded-sm border border-[var(--console-border)] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                >
                  <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
                    {block.parts.map((part, partIndex) => (
                      <MessageMarkdown
                        key={partIndex}
                        text={extractMessageText(part.text)}
                        highlightQuery={highlightQuery}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}

          {!isUser && (msg.tokens || msg.cost) && (
            <div className="flex flex-wrap gap-2">
              {msg.tokens?.input ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  INPUT {fmtTokens(msg.tokens.input)}
                </span>
              ) : null}
              {msg.tokens?.output ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  OUTPUT {fmtTokens(msg.tokens.output)}
                </span>
              ) : null}
              {msg.tokens?.reasoning ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  REASONING {fmtTokens(msg.tokens.reasoning)}
                </span>
              ) : null}
              {msg.cost ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  COST ${msg.cost.toFixed(4)}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AbortToolItem() {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-full rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] md:w-[560px]">
          <div className="flex items-start gap-2">
            <MessageCircleX className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
            <span className="min-w-0 flex-1">
              <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                abort
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReasoningSection({
  parts,
  highlightQuery,
}: {
  parts: MessagePart[];
  highlightQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fullText = parts
    .map((p) => extractMessageText(p.text))
    .filter(Boolean)
    .join("\n\n");

  return (
    <div className="overflow-hidden rounded-sm border border-[var(--console-thinking-border)] bg-[var(--console-thinking-bg)]">
      <div
        className="flex cursor-pointer items-center justify-between bg-[var(--console-surface-muted)] px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="console-mono flex items-center gap-2 text-xs font-medium text-[var(--console-muted)]">
          <Lightbulb className="size-3.5" />
          Thinking
        </span>
        <span className="text-[var(--console-muted)]">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-dashed border-[var(--console-thinking-border)] px-4 py-3">
          <div className="console-mono whitespace-pre-wrap text-xs leading-relaxed text-[var(--console-muted)]">
            {renderHighlightedText(fullText, highlightQuery)}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolsSection({
  parts,
  toolAnchorIds,
  sessionAgentKey,
  highlightQuery,
}: {
  parts: MessagePart[];
  toolAnchorIds: Map<MessagePart, string>;
  sessionAgentKey: string;
  highlightQuery?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {parts.map((tool, i) => (
          <ToolItem
            key={i}
            tool={tool}
            anchorId={toolAnchorIds.get(tool)}
            sessionAgentKey={sessionAgentKey}
            highlightQuery={highlightQuery}
          />
        ))}
      </div>
    </div>
  );
}

function PlansSection({
  parts,
  highlightQuery,
}: {
  parts: MessagePart[];
  highlightQuery?: string;
}) {
  return (
    <div className="space-y-2">
      {parts.map((plan, i) => (
        <PlanItem key={i} part={plan} highlightQuery={highlightQuery} />
      ))}
    </div>
  );
}

function PlanItem({ part, highlightQuery }: { part: MessagePart; highlightQuery?: string }) {
  const [expanded, setExpanded] = useState(false);
  const display = buildCodexPlanDisplay(part);
  const statusMeta =
    display.approvalStatus === "fail" ? TOOL_STATUS_META.error : TOOL_STATUS_META.completed;
  const StatusIcon = statusMeta.icon;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={`w-full md:w-[560px] rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] ${
            display.expandable ? "transition-colors hover:bg-[var(--console-surface-muted)]" : ""
          }`}
        >
          {display.expandable ? (
            <button
              type="button"
              className="flex w-full items-start gap-2 text-left"
              onClick={() => setExpanded(!expanded)}
            >
              <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {display.title}
                </span>
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--console-muted)]">
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {display.title}
                </span>
              </span>
            </div>
          )}
        </div>
        <span
          className={`console-mono inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusMeta.className}`}
        >
          <StatusIcon className="size-3" />
          {statusMeta.label}
        </span>
      </div>

      {display.expandable && expanded ? (
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <span className="console-mono text-xs text-[var(--console-muted)]">
              {display.contentLabel}
            </span>
          </div>
          <div className="p-4">
            <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
              <MessageMarkdown text={display.contentMarkdown} highlightQuery={highlightQuery} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolItem({
  tool,
  anchorId,
  sessionAgentKey,
  highlightQuery,
}: {
  tool: MessagePart;
  anchorId?: string;
  sessionAgentKey: string;
  highlightQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const state = normalizeToolState(tool);
  const strategy = getToolDisplayStrategy(sessionAgentKey, tool, state);
  const statusMeta = TOOL_STATUS_META[state.status];
  const StatusIcon = statusMeta.icon;
  const ToolIcon = strategy.Icon;

  return (
    <div id={anchorId} className="scroll-mt-6 space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={`w-full md:w-[560px] rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] ${
            strategy.expandable ? "transition-colors hover:bg-[var(--console-surface-muted)]" : ""
          }`}
        >
          {strategy.expandable ? (
            <button
              type="button"
              className="flex w-full items-start gap-2 text-left"
              onClick={() => setExpanded(!expanded)}
            >
              <ToolIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {strategy.title}
                </span>
                {strategy.secondaryText ? (
                  <span className="console-mono mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                    {renderHighlightedText(strategy.secondaryText, highlightQuery)}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--console-muted)]">
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <ToolIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {strategy.title}
                </span>
                {strategy.secondaryText ? (
                  <span className="console-mono mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                    {renderHighlightedText(strategy.secondaryText, highlightQuery)}
                  </span>
                ) : null}
              </span>
            </div>
          )}
        </div>
        <span
          className={`console-mono inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusMeta.className}`}
        >
          <StatusIcon className={`size-3 ${state.status === "running" ? "animate-spin" : ""}`} />
          {statusMeta.label}
        </span>
      </div>

      {strategy.expandable && expanded ? (
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <span className="console-mono text-xs text-[var(--console-muted)]">Output</span>
          </div>
          <div className="space-y-3 p-3">
            {strategy.details.length > 0 ? (
              <div className="rounded-sm border border-[var(--console-border)] bg-[#fafafa] px-3 py-2">
                <div className="space-y-2">
                  {strategy.details.map((detail) => (
                    <div
                      key={`${detail.label}:${detail.value}`}
                      className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3"
                    >
                      <span className="console-mono shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--console-muted)] md:w-24">
                        {detail.label}
                      </span>
                      <span className="console-mono whitespace-pre-wrap break-all text-xs leading-relaxed text-[var(--console-text)]">
                        {renderHighlightedText(detail.value, highlightQuery)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <ToolOutputRenderer outputContent={strategy.outputContent} />
          </div>
          {strategy.showInputPreview ? (
            <div className="border-t border-[var(--console-border)] bg-[#fafafa] px-3 py-2">
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
                Input Preview
              </span>
              <pre className="console-mono mt-1 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-all text-xs leading-relaxed text-[var(--console-muted)]">
                {renderHighlightedText(state.inputText || "{}", highlightQuery)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
