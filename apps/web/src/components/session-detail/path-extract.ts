/**
 * File-path extraction and display-path formatting.
 * Consumed by file-change summary and tool display strategies.
 */
import { escapeRegExp, parseJsonText } from "./utils";
import { toPlainText, toRecord } from "./tool-normalize";

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

let relativePathPatternCache: { base: string; pattern: RegExp } | null = null;

function getRelativePathPattern(base: string): RegExp {
  if (relativePathPatternCache?.base !== base) {
    relativePathPatternCache = {
      base,
      pattern: new RegExp(`${escapeRegExp(base)}(?=$|/|[\\s"'\\)\\]}:;,])`, "g"),
    };
  }
  relativePathPatternCache.pattern.lastIndex = 0;
  return relativePathPatternCache.pattern;
}

export function getDisplayTextWithRelativePaths(text: string, baseDirectory?: string) {
  const normalizedBase = (baseDirectory ?? "").replace(/\/+$/, "");
  if (!text || !normalizedBase) return text;

  return text.replace(getRelativePathPattern(normalizedBase), ".");
}

export function formatTrackedPath(path: string, baseDirectory: string) {
  if (path.startsWith(`${baseDirectory}/`)) {
    return path.slice(baseDirectory.length + 1);
  }
  return path;
}

// Re-exported for tool-strategy / file-change consumers that need JSON cursor output parsing.
export { parseJsonText };
