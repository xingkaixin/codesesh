/**
 * File-path extraction and display-path formatting.
 * Consumed by file-change summary and tool display strategies.
 */
import type { MessagePart } from "../../lib/api";
import { escapeRegExp, parseJsonText } from "./utils";
import { toPlainText, toRecord } from "./tool-normalize";

export function looksLikeFilePath(value: string) {
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

export function shouldTreatAsPathKey(key: string) {
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

export function collectPathsFromValue(
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

export function extractPathsFromToolInput(inputValue: unknown) {
  const paths = new Set<string>();
  collectPathsFromValue(inputValue, "", paths);
  return [...paths];
}

export function getToolInputValue(part: MessagePart) {
  return part.state?.arguments ?? part.state?.input ?? part.input ?? null;
}

export function getFilePathFromInput(inputValue: unknown) {
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

export function getDisplayPath(filePath: string, baseDirectory?: string) {
  const normalizedPath = filePath.trim();
  const normalizedBase = (baseDirectory ?? "").replace(/\/+$/, "");
  if (!normalizedPath || !normalizedBase) return normalizedPath;
  if (normalizedPath === normalizedBase) return ".";
  if (normalizedPath.startsWith(`${normalizedBase}/`)) {
    return normalizedPath.slice(normalizedBase.length + 1);
  }
  return normalizedPath;
}

export function getDisplayTextWithRelativePaths(text: string, baseDirectory?: string) {
  const normalizedBase = (baseDirectory ?? "").replace(/\/+$/, "");
  if (!text || !normalizedBase) return text;

  return text.replace(
    new RegExp(`${escapeRegExp(normalizedBase)}(?=$|/|[\\s"'\\)\\]}:;,])`, "g"),
    ".",
  );
}

export function formatTrackedPath(path: string, baseDirectory: string) {
  if (path.startsWith(`${baseDirectory}/`)) {
    return path.slice(baseDirectory.length + 1);
  }
  return path;
}

// Re-exported for tool-strategy / file-change consumers that need JSON cursor output parsing.
export { parseJsonText };
