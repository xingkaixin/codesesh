/**
 * File-change classification and per-path summary aggregation.
 * Classifies tool calls into read/edit/write/delete kinds and builds
 * per-path summaries (with anchor ids for click-to-scroll).
 */
import {
  classifyFileTool,
  extractFileToolOperations,
  type FileActivityKind,
} from "@codesesh/core/contract";
import type { Message, SessionFileActivity, ToolPart } from "../../lib/api";
import type { MessageDisplayModel } from "./display-model-types";
import { normalizeToolLabel } from "./tool-normalize";

export type FileChangeKind = FileActivityKind;

/** Coarse operation class shared by the reader's tool filter and the timeline. */
export type ToolOperationKind = "read" | "write" | "execute";

export interface FileChangeRecord {
  kind: FileChangeKind;
  path: string;
  anchorId: string;
  time: number;
  toolLabel: string;
}

export interface FileChangeSummaryItem {
  path: string;
  count: number;
  latestTime: number;
  latestAnchorId: string;
  toolLabel: string;
  anchors: Array<{ anchorId: string; time: number; toolLabel: string }>;
}

export interface FileChangeSummary {
  read: FileChangeSummaryItem[];
  edit: FileChangeSummaryItem[];
  write: FileChangeSummaryItem[];
  delete: FileChangeSummaryItem[];
}

export function buildToolAnchorId(messageIndex: number, toolIndex: number) {
  return `tool-${messageIndex}-${toolIndex}`;
}

export function classifyToolOperation(part: ToolPart): ToolOperationKind {
  const fileKind = classifyFileTool(part);
  if (fileKind === "read") return "read";
  if (fileKind) return "write";
  return "execute";
}

export function summarizeFileChangeItems(records: FileChangeRecord[]): FileChangeSummaryItem[] {
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

export function buildFileChangeSummary(messages: MessageDisplayModel[]): {
  anchorMessageIndexes: Map<string, number>;
  summary: FileChangeSummary;
} {
  const anchorMessageIndexes = new Map<string, number>();
  const fileChanges: Record<FileChangeKind, FileChangeRecord[]> = {
    read: [],
    edit: [],
    write: [],
    delete: [],
  };

  messages.forEach(({ msg: message, blocks, index: messageIndex }) => {
    let toolIndex = 0;

    for (const block of blocks) {
      if (block.type !== "tool") continue;

      for (const [partIndex, part] of block.parts.entries()) {
        const anchorId = block.anchorIds?.[partIndex] ?? buildToolAnchorId(messageIndex, toolIndex);
        toolIndex += 1;
        anchorMessageIndexes.set(anchorId, messageIndex);

        const toolLabel = normalizeToolLabel(part);
        const time = part.time_created ?? message.time_created;

        for (const { kind, path } of extractFileToolOperations(part)) {
          fileChanges[kind].push({ kind, path, anchorId, time, toolLabel });
        }
      }
    }
  });

  return {
    anchorMessageIndexes,
    summary: {
      read: summarizeFileChangeItems(fileChanges.read),
      edit: summarizeFileChangeItems(fileChanges.edit),
      write: summarizeFileChangeItems(fileChanges.write),
      delete: summarizeFileChangeItems(fileChanges.delete),
    },
  };
}

export function buildFileChangeSummaryFromActivity(
  activity: SessionFileActivity[] | undefined,
  anchorSummary: FileChangeSummary,
): FileChangeSummary {
  if (!activity) return anchorSummary;

  const fromActivity: FileChangeSummary = {
    read: [],
    edit: [],
    write: [],
    delete: [],
  };
  const anchorMap = new Map<string, FileChangeSummaryItem>();

  for (const kind of ["read", "edit", "write", "delete"] as const) {
    for (const item of anchorSummary[kind]) {
      anchorMap.set(`${kind}\0${item.path}`, item);
    }
  }

  for (const item of activity) {
    const anchors = anchorMap.get(`${item.kind}\0${item.path}`);
    fromActivity[item.kind].push({
      path: item.path,
      count: item.count,
      latestTime: item.latestTime,
      latestAnchorId: anchors?.latestAnchorId ?? "",
      toolLabel: anchors?.toolLabel ?? item.kind,
      anchors: anchors?.anchors ?? [],
    });
  }

  for (const kind of ["read", "edit", "write", "delete"] as const) {
    fromActivity[kind].sort((a, b) => {
      if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime;
      return a.path.localeCompare(b.path);
    });
  }

  return fromActivity;
}

// Keep Message import meaningful for downstream typing consumers.
export type { Message };
