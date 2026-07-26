import type { ToolPart } from "../../lib/api";
import type { MessageDisplayModel } from "./display-model";
import type { MessageBlock } from "./blocks";

export type TocFilterId = "user" | "agent_message" | "thinking" | "plan" | "tools_all";

export interface ToolFilterItem {
  id: `tool:${string}`;
  toolKey: string;
  label: string;
  count: number;
}

export interface SessionDetailToc {
  filterIds: Set<string>;
  counts: Record<TocFilterId, number>;
  tools: ToolFilterItem[];
}

export interface FilteredSessionMessage {
  msg: MessageDisplayModel["msg"];
  blocks: MessageBlock[];
  index: number;
}

type ToolMessageBlock = Extract<MessageBlock, { type: "tool" }>;

function buildToolLabel(part: ToolPart) {
  if (isNodeReplBrowserTool(part)) return "Browser";
  if (part.title?.trim()) {
    return cleanToolLabel(part.title);
  }
  if (part.tool.trim()) return cleanToolLabel(part.tool);
  return "tool";
}

function normalizeToolKey(part: ToolPart) {
  if (isNodeReplBrowserTool(part)) return "browser";
  const raw = part.tool.trim() ? part.tool : buildToolLabel(part);
  return cleanToolLabel(raw).toLowerCase();
}

function cleanToolLabel(value: string) {
  return value
    .trim()
    .replace(/^tool:\s*/i, "")
    .replace(/^\.+(?=\w)/, "");
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

function isNodeReplBrowserTool(part: ToolPart) {
  const metadata = toRecord(part.state.metadata);
  const namespace = toPlainText(metadata.namespace);
  return (
    cleanToolLabel(toPlainText(part.tool)).toLowerCase() === "js" &&
    (namespace === "mcp__node_repl__" || namespace === "mcp__node_repl__.js")
  );
}

function countToolPart(toolMap: Map<string, ToolFilterItem>, part: ToolPart) {
  const key = normalizeToolKey(part);
  const id = `tool:${key}` as const;
  const cur = toolMap.get(key);
  if (cur) {
    cur.count += 1;
    return;
  }
  toolMap.set(key, { id, toolKey: key, label: buildToolLabel(part), count: 1 });
}

export function buildSessionDetailToc(messages: MessageDisplayModel[]): SessionDetailToc {
  const counts: Record<TocFilterId, number> = {
    user: 0,
    agent_message: 0,
    thinking: 0,
    plan: 0,
    tools_all: 0,
  };
  const filterIds = new Set<string>();
  const toolMap = new Map<string, ToolFilterItem>();

  for (const { msg, blocks } of messages) {
    for (const block of blocks) {
      if (msg.role === "user") {
        counts.user += 1;
        filterIds.add("user");
        continue;
      }
      if (block.type === "text") {
        counts.agent_message += 1;
        filterIds.add("agent_message");
        continue;
      }
      if (block.type === "reasoning") {
        counts.thinking += 1;
        filterIds.add("thinking");
        continue;
      }
      if (block.type === "plan") {
        counts.plan += 1;
        filterIds.add("plan");
        continue;
      }

      counts.tools_all += block.parts.length;
      filterIds.add("tools_all");
      for (const part of block.parts) {
        countToolPart(toolMap, part);
        filterIds.add(`tool:${normalizeToolKey(part)}`);
      }
    }
  }

  return {
    filterIds,
    counts,
    tools: [...toolMap.values()].toSorted((a, b) => a.label.localeCompare(b.label)),
  };
}

function isToolPartVisible(part: ToolPart, filters: Set<string>) {
  return filters.has(`tool:${normalizeToolKey(part)}`);
}

function isBlockVisible(
  block: MessageBlock,
  msg: MessageDisplayModel["msg"],
  filters: Set<string>,
) {
  if (msg.role === "user") return filters.has("user");
  if (block.type === "text") return filters.has("agent_message");
  if (block.type === "reasoning") return filters.has("thinking");
  if (block.type === "plan") return filters.has("plan");
  return block.parts.some((p) => isToolPartVisible(p, filters));
}

function filterToolBlock(block: ToolMessageBlock, filters: Set<string>): ToolMessageBlock | null {
  const visibleIndexes = block.parts
    .map((part, index) => (isToolPartVisible(part, filters) ? index : -1))
    .filter((index) => index >= 0);
  const parts = visibleIndexes.map((index) => block.parts[index]!);
  if (parts.length === 0) return null;
  return {
    ...block,
    parts,
    anchorIds: block.anchorIds
      ? visibleIndexes.map((index) => block.anchorIds![index]!)
      : undefined,
  };
}

export function filterSessionMessages(
  messages: MessageDisplayModel[],
  selectedFilters: Set<string>,
): FilteredSessionMessage[] {
  return messages
    .map((model) => {
      const blocks = model.blocks
        .filter((b) => isBlockVisible(b, model.msg, selectedFilters))
        .map((b) => (b.type === "tool" ? filterToolBlock(b, selectedFilters) : b))
        .filter((b): b is MessageBlock => b != null);
      if (blocks.length === 0) return null;
      return { msg: model.msg, blocks, index: model.index };
    })
    .filter((item): item is FilteredSessionMessage => item != null);
}
