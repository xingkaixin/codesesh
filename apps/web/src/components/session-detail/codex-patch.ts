import type { ToolOutputContent, ToolOutputLanguage, FileSectionItem } from "../tool-output/types";

export interface CodexPatchEntry {
  type: string;
  path: string;
  oldPath: string;
  targetPath: string;
  content: string;
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

function normalizeEscapedNewlines(text: string) {
  return text.replace(/\\n/g, "\n");
}

export function normalizeCodexPatchEntry(entry: unknown): CodexPatchEntry | null {
  const record = toRecord(entry);
  const type = toStringValue(record.type);
  if (!type) {
    return null;
  }

  return {
    type,
    path: toStringValue(record.path),
    oldPath: toStringValue(record.old_path),
    targetPath: toStringValue(record.targetPath),
    content: toStringValue(record.content) || toStringValue(toRecord(record.input).content),
  };
}

export function getCodexPatchEntries(inputValue: unknown): CodexPatchEntry[] {
  const rawContent: unknown[] = Array.isArray(inputValue)
    ? inputValue
    : Array.isArray(toRecord(inputValue).content)
      ? (toRecord(inputValue).content as unknown[])
      : [];

  return rawContent
    .map((entry: unknown) => normalizeCodexPatchEntry(entry))
    .filter((entry): entry is CodexPatchEntry => entry != null);
}

function formatCount(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function summarizeCodexPatchEntries(entries: CodexPatchEntry[]) {
  const writeCount = entries.filter((entry) => entry.type === "write_file").length;
  const editCount = entries.filter((entry) => entry.type === "edit_file").length;
  const deleteCount = entries.filter((entry) => entry.type === "delete_file").length;
  const moveCount = entries.filter((entry) => entry.type === "move_file").length;
  const parts = [];

  if (writeCount > 0) {
    parts.push(formatCount(writeCount, "write", "writes"));
  }
  if (editCount > 0) {
    parts.push(formatCount(editCount, "edit", "edits"));
  }
  if (deleteCount > 0) {
    parts.push(formatCount(deleteCount, "delete", "deletes"));
  }
  if (moveCount > 0) {
    parts.push(formatCount(moveCount, "move", "moves"));
  }

  return parts.join(" · ");
}

function getSectionLabel(entry: CodexPatchEntry) {
  return entry.targetPath || entry.path || entry.oldPath || entry.type;
}

function buildCodexPatchSections(
  entries: CodexPatchEntry[],
  detectLanguageByFilePath: (filePath: string) => ToolOutputLanguage,
  formatPathForDisplay: (path: string) => string,
) {
  return entries.reduce<FileSectionItem[]>((sections, entry) => {
    if (entry.type === "write_file") {
      sections.push({
        label: formatPathForDisplay(getSectionLabel(entry)),
        operation: "write",
        language: detectLanguageByFilePath(entry.path),
        isCode: true,
        text: normalizeEscapedNewlines(entry.content),
      });
      return sections;
    }

    if (entry.type === "edit_file") {
      sections.push({
        label: formatPathForDisplay(getSectionLabel(entry)),
        operation: "edit",
        language: "diff",
        isCode: true,
        text: normalizeEscapedNewlines(entry.content),
      });
      return sections;
    }

    if (entry.type === "delete_file") {
      sections.push({
        label: formatPathForDisplay(getSectionLabel(entry)),
        operation: "edit",
        language: "text",
        isCode: false,
        text: "File deleted.",
      });
      return sections;
    }

    if (entry.type === "move_file") {
      sections.push({
        label: formatPathForDisplay(getSectionLabel(entry)),
        operation: "edit",
        language: "text",
        isCode: false,
        text:
          entry.targetPath && entry.path
            ? `Moved from ${formatPathForDisplay(entry.path)} to ${formatPathForDisplay(entry.targetPath)}`
            : entry.oldPath
              ? `Moved from ${formatPathForDisplay(entry.oldPath)}`
              : "File moved.",
      });
    }

    return sections;
  }, []);
}

export function buildCodexPatchOutputContent(
  entries: CodexPatchEntry[],
  fallbackText: string,
  detectLanguageByFilePath: (filePath: string) => ToolOutputLanguage,
  formatPathForDisplay: (path: string) => string = (path) => path,
): ToolOutputContent {
  const sections = buildCodexPatchSections(entries, detectLanguageByFilePath, formatPathForDisplay);
  if (sections.length > 0) {
    return {
      kind: "file-sections",
      sections,
    };
  }

  return {
    kind: "plain",
    text: fallbackText,
    language: "text",
    isCode: false,
  };
}
