/**
 * Tool / message text normalization and the shared NormalizedToolState type.
 *
 * Leaf helpers (escapeRegExp, parseInputCandidate, compactText, toRecord,
 * toPlainText, toStringValue, parseJsonText, normalizeEscapedNewlines) live
 * in ./utils and are re-exported here for convenience.
 */
import type { LoaderCircle } from "lucide-react";
import type { MessagePart } from "../../lib/api";
import type { ToolOutputContent } from "../tool-output/types";
import type { ToolDetailItem } from "./codex-tool";
import {
  compactText,
  normalizeEscapedNewlines,
  parseInputCandidate,
  toPlainText,
  toRecord,
  toStringValue,
} from "./utils";

export type ToolStatus = "running" | "completed" | "error";

export interface NormalizedToolState {
  status: ToolStatus;
  inputValue: unknown;
  outputValue: unknown;
  errorValue: unknown;
  metadataValue: unknown;
  inputText: string;
  command: string;
}

export interface ToolDisplayStrategy {
  Icon: typeof LoaderCircle;
  title: string;
  secondaryText?: string;
  details: ToolDetailItem[];
  expandable: boolean;
  showInputPreview: boolean;
  outputContent: ToolOutputContent;
}

export function toDisplayText(value: unknown) {
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

export {
  compactText,
  normalizeEscapedNewlines,
  parseInputCandidate,
  toPlainText,
  toRecord,
  toStringValue,
};

export function extractToolTextSegments(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => extractToolTextSegments(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return [record.text];
    if (record.content !== undefined) return extractToolTextSegments(record.content);
  }
  return [];
}

export function stripSystemTag(text: string) {
  return text
    .replace(/^<system>/i, "")
    .replace(/<\/system>$/i, "")
    .trim();
}

export function joinToolText(value: unknown, includeSystem = true) {
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

export function extractCommand(inputValue: unknown) {
  const parsed = parseInputCandidate(inputValue);
  if (parsed && typeof parsed === "object") {
    const input = parsed as { cmd?: unknown; command?: unknown };
    if (typeof input.cmd === "string") return input.cmd;
    if (typeof input.command === "string") return input.command;
  }
  return "";
}

export function cleanToolTitle(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^tool:\s*/i, "").replace(/^\.+(?=\w)/, "");
}

export function normalizeToolLabel(part: MessagePart) {
  if (typeof part.title === "string" && part.title.trim()) {
    return cleanToolTitle(part.title);
  }
  if (typeof part.tool === "string" && part.tool.trim()) return cleanToolTitle(part.tool);
  return "tool";
}

export function normalizeToolName(part: MessagePart) {
  return normalizeToolLabel(part).trim().toLowerCase();
}

export function getToolTitle(tool: MessagePart, fallback = "Tool") {
  return cleanToolTitle(toPlainText(tool.title)) || toPlainText(tool.tool) || fallback;
}

export function formatToolOutput(value: unknown) {
  const structuredText = joinToolText(value);
  const text = structuredText || toDisplayText(value);
  const normalized = normalizeEscapedNewlines(text);
  return normalized || "No output captured.";
}

export function getOutputOrErrorText(state: NormalizedToolState) {
  const outputText = formatToolOutput(state.outputValue);
  if (outputText !== "No output captured.") return outputText;
  const errorText = formatToolOutput(state.errorValue);
  if (errorText !== "No output captured.") return errorText;
  return "No output captured.";
}
