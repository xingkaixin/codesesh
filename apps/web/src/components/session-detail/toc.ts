import { t } from "../../i18n/translate";
import type { ToolPart } from "../../lib/api";
import type { FilteredSessionMessage, MessageDisplayModel } from "./display-model-types";
import type { MessageBlock } from "./blocks";
import { classifyToolOperation, type ToolOperationKind } from "./file-change";

/** The four content kinds the reader can toggle independently of tools. */
export type TocContentFilterId = "user" | "agent_message" | "thinking" | "plan";

export type TocFilterId = TocContentFilterId | "tools_all";

export const TOC_CONTENT_FILTER_IDS = [
  "user",
  "agent_message",
  "thinking",
  "plan",
] as const satisfies readonly TocContentFilterId[];

export interface ToolFilterItem {
  id: `tool:${string}`;
  toolKey: string;
  label: string;
  count: number;
  kind: ToolOperationKind;
}

export interface SessionDetailToc {
  /** Selectable filter ids only — `tools_all` is derived from the tool subset. */
  filterIds: Set<string>;
  counts: Record<TocFilterId, number>;
  tools: ToolFilterItem[];
  /** Largest per-tool count, the denominator of the usage bars. */
  maxToolCount: number;
  /** Every filterable unit: content blocks plus individual tool parts. */
  totalUnitCount: number;
}

export type { FilteredSessionMessage } from "./display-model-types";

type ToolMessageBlock = Extract<MessageBlock, { type: "tool" }>;

function buildToolLabel(part: ToolPart) {
  if (isNodeReplBrowserTool(part)) return t("Browser");
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
  toolMap.set(key, {
    id,
    toolKey: key,
    label: buildToolLabel(part),
    count: 1,
    kind: classifyToolOperation(part),
  });
}

/** Tool blocks are classified by the tool branch whatever the role; every other
 *  block inside a user message counts as the user's own content. */
function contentFilterIdOf(
  block: Exclude<MessageBlock, ToolMessageBlock>,
  msg: MessageDisplayModel["msg"],
): TocContentFilterId {
  if (msg.role === "user") return "user";
  if (block.type === "reasoning") return "thinking";
  if (block.type === "plan") return "plan";
  return "agent_message";
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
      if (block.type === "tool") {
        counts.tools_all += block.parts.length;
        for (const part of block.parts) {
          countToolPart(toolMap, part);
          filterIds.add(`tool:${normalizeToolKey(part)}`);
        }
        continue;
      }

      const id = contentFilterIdOf(block, msg);
      counts[id] += 1;
      filterIds.add(id);
    }
  }

  const tools = [...toolMap.values()].toSorted((a, b) => a.label.localeCompare(b.label));

  return {
    filterIds,
    counts,
    tools,
    maxToolCount: tools.reduce((max, tool) => Math.max(max, tool.count), 0),
    totalUnitCount:
      counts.user + counts.agent_message + counts.thinking + counts.plan + counts.tools_all,
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
  if (block.type === "tool") return block.parts.some((p) => isToolPartVisible(p, filters));
  return filters.has(contentFilterIdOf(block, msg));
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

export interface FilteredSessionMessages {
  messages: FilteredSessionMessage[];
  /** Units left on screen, counted the way `SessionDetailToc.counts` counts them. */
  visibleUnitCount: number;
}

export function filterSessionMessages(
  messages: MessageDisplayModel[],
  selectedFilters: Set<string>,
): FilteredSessionMessages {
  const filtered: FilteredSessionMessage[] = [];
  let visibleUnitCount = 0;

  for (const model of messages) {
    const blocks = model.blocks
      .filter((b) => isBlockVisible(b, model.msg, selectedFilters))
      .map((b) => (b.type === "tool" ? filterToolBlock(b, selectedFilters) : b))
      .filter((b): b is MessageBlock => b != null);
    if (blocks.length === 0) continue;

    for (const block of blocks) visibleUnitCount += block.type === "tool" ? block.parts.length : 1;
    filtered.push({ msg: model.msg, blocks, index: model.index });
  }

  return { messages: filtered, visibleUnitCount };
}
