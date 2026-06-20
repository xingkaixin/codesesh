/**
 * Diff block construction for tool edit/write strategies.
 * Builds DiffBlock[] from text pairs (claude/pi), Kimi edit arrays,
 * and extracts edit-diff text for opencode/kimi output.
 */
import { diffLines, type Change } from "diff";
import type { DiffBlock, DiffLineItem } from "../tool-output/types";
import {
  type NormalizedToolState,
  getOutputOrErrorText,
  normalizeEscapedNewlines,
  toStringValue,
  toRecord,
} from "./tool-normalize";

export function buildStructuredDiffFromTexts(
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

export function createDiffBlock(oldValue: string, newValue: string) {
  const oldLines = normalizeEscapedNewlines(oldValue).split("\n");
  const newLines = normalizeEscapedNewlines(newValue).split("\n");
  const diffLines = [
    "@@",
    ...oldLines.map((line) => `- ${line}`),
    ...newLines.map((line) => `+ ${line}`),
  ];
  return diffLines.join("\n");
}

export function splitDiffChunkLines(value: string) {
  const normalized = normalizeEscapedNewlines(value);
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function diffPartsToLines(parts: Change[]): DiffLineItem[] {
  return parts.flatMap((part) => {
    const type: DiffLineItem["type"] = part.added ? "add" : part.removed ? "remove" : "context";
    return splitDiffChunkLines(part.value).map((line) => ({ type, text: line }));
  });
}

export function getKimiEditEntries(inputValue: unknown) {
  const input = toRecord(inputValue);
  const rawEdit = input.edit;
  if (Array.isArray(rawEdit)) return rawEdit;
  if (rawEdit && typeof rawEdit === "object") return [rawEdit];
  return [];
}

export function getDiffBlockLabel(filePath: string) {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) return "edit";
  const fileName = normalizedPath.split("/").pop() || normalizedPath;
  return fileName === normalizedPath ? fileName : `${fileName} · ${normalizedPath}`;
}

export function buildKimiEditDiffBlocks(state: NormalizedToolState, filePath: string): DiffBlock[] {
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

export function buildPiEditDiffBlocks(state: NormalizedToolState, filePath: string): DiffBlock[] {
  const input = toRecord(state.inputValue);
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const label = getDiffBlockLabel(filePath);
  const blocks = edits
    .map((entry) => {
      const edit = toRecord(entry);
      const oldValue = toStringValue(edit.oldText) || toStringValue(edit.old);
      const newValue = toStringValue(edit.newText) || toStringValue(edit.new);
      if (!oldValue.trim() && !newValue.trim()) return null;
      return {
        label,
        lines: diffPartsToLines(
          diffLines(normalizeEscapedNewlines(oldValue), normalizeEscapedNewlines(newValue)),
        ),
      };
    })
    .filter((block): block is DiffBlock => block != null && block.lines.length > 0);

  if (blocks.length > 0) return blocks;

  const metadata = toRecord(state.metadataValue);
  const patch = toStringValue(metadata.patch) || toStringValue(metadata.diff);
  if (!patch.trim()) return [];
  return [
    {
      label,
      lines: patch.split("\n").map((line) => ({
        type: line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context",
        text: line,
      })),
    },
  ];
}

export function extractEditDiff(state: NormalizedToolState) {
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
