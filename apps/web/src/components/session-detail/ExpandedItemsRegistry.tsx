import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { buildCodexPlanDisplay } from "./codex-plan";
import { isCodexTurnAbortedMessage } from "./codex-abort";
import { getToolDisplayStrategy, normalizeToolState } from "./tool-strategy";
import type { FilteredSessionMessage } from "./toc";
import { buildBlockTimelineAnchorId } from "./timeline";
import {
  buildHighlightPattern,
  matchesHighlightPattern,
  valueMatchesHighlight,
} from "../../lib/search-highlight";

const MAX_NON_TARGET_AUTO_EXPAND = 20;

export interface ExpandedItemsSnapshot {
  readonly defaultExpanded: boolean;
  readonly overrides: ReadonlySet<string>;
}

export interface ExpandedItemsRegistry {
  readonly sessionKey: string;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  expandItems: (keys: Iterable<string>) => void;
  expandAll: () => void;
  collapseAll: () => void;
  getSnapshot: () => ExpandedItemsSnapshot;
  subscribe: (listener: () => void) => () => void;
}

const noopSubscribe = () => () => {};

export function createExpandedItemsRegistry(sessionKey: string): ExpandedItemsRegistry {
  let snapshot: ExpandedItemsSnapshot = {
    defaultExpanded: false,
    overrides: new Set<string>(),
  };
  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  return {
    sessionKey,
    isExpanded: (key) =>
      snapshot.defaultExpanded ? !snapshot.overrides.has(key) : snapshot.overrides.has(key),
    toggle: (key) => {
      const nextOverrides = new Set(snapshot.overrides);
      if (nextOverrides.has(key)) nextOverrides.delete(key);
      else nextOverrides.add(key);
      snapshot = { defaultExpanded: snapshot.defaultExpanded, overrides: nextOverrides };
      notify();
    },
    expandItems: (keys) => {
      const nextOverrides = new Set(snapshot.overrides);
      let changed = false;
      for (const key of keys) {
        if (snapshot.defaultExpanded) {
          if (nextOverrides.delete(key)) changed = true;
        } else if (!nextOverrides.has(key)) {
          nextOverrides.add(key);
          changed = true;
        }
      }
      if (!changed) return;
      snapshot = { defaultExpanded: snapshot.defaultExpanded, overrides: nextOverrides };
      notify();
    },
    expandAll: () => {
      if (snapshot.defaultExpanded && snapshot.overrides.size === 0) return;
      snapshot = { defaultExpanded: true, overrides: new Set<string>() };
      notify();
    },
    collapseAll: () => {
      if (!snapshot.defaultExpanded && snapshot.overrides.size === 0) return;
      snapshot = { defaultExpanded: false, overrides: new Set<string>() };
      notify();
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function buildReasoningItemKey(anchorId: string) {
  return `reasoning:${anchorId}`;
}

export function buildPlanItemKey(anchorId: string, planIndex: number) {
  return `plan:${anchorId}:${planIndex}`;
}

export function buildToolItemKey(
  anchorId: string | undefined,
  messageIndex: number,
  blockIndex: number,
  partIndex: number,
) {
  return anchorId ?? `tool:${messageIndex}:${blockIndex}:${partIndex}`;
}

function* collapsibleKeys(messages: FilteredSessionMessage[], agent: string, directory: string) {
  for (const { blocks, index: messageIndex, msg } of messages) {
    if (isCodexTurnAbortedMessage(msg, agent)) continue;
    for (const [blockIndex, block] of blocks.entries()) {
      const anchor = block.anchorIds?.[0] ?? buildBlockTimelineAnchorId(messageIndex, blockIndex);
      if (block.type === "reasoning") yield buildReasoningItemKey(anchor);
      if (block.type === "plan") {
        for (const [index, plan] of block.parts.entries()) {
          if (buildCodexPlanDisplay(plan).expandable) yield buildPlanItemKey(anchor, index);
        }
      }
      if (block.type === "tool") {
        for (const [index, tool] of block.parts.entries()) {
          if (
            getToolDisplayStrategy(agent, tool, normalizeToolState(tool), directory, {
              includeOutput: false,
            }).expandable
          ) {
            yield buildToolItemKey(block.anchorIds?.[index], messageIndex, blockIndex, index);
          }
        }
      }
    }
  }
}

export function collectMatchedCollapsibleKeys(
  messages: FilteredSessionMessage[],
  highlightQuery?: string,
  targetDisplayMessageIndex?: number,
): string[] {
  const pattern = buildHighlightPattern(highlightQuery);
  if (!pattern) return [];

  const targetKeys: string[] = [];
  const otherKeys: string[] = [];

  for (const { blocks, index: messageIndex } of messages) {
    const isTarget =
      targetDisplayMessageIndex != null && messageIndex === targetDisplayMessageIndex;
    if (!isTarget && otherKeys.length >= MAX_NON_TARGET_AUTO_EXPAND) continue;

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]!;
      const destination = isTarget ? targetKeys : otherKeys;

      if (block.type === "reasoning") {
        if (block.parts.some((part) => matchesHighlightPattern(part.text, pattern))) {
          destination.push(
            buildReasoningItemKey(block.anchorIds?.[0] ?? buildBlockTimelineAnchorId(messageIndex, blockIndex)),
          );
        }
      } else if (block.type === "plan") {
        const anchorId = block.anchorIds?.[0] ?? buildBlockTimelineAnchorId(messageIndex, blockIndex);
        for (let planIndex = 0; planIndex < block.parts.length; planIndex += 1) {
          if (matchesHighlightPattern(block.parts[planIndex]!.text, pattern)) {
            destination.push(buildPlanItemKey(anchorId, planIndex));
          }
        }
      } else if (block.type === "tool") {
        for (let partIndex = 0; partIndex < block.parts.length; partIndex += 1) {
          const tool = block.parts[partIndex]!;
          const matched =
            valueMatchesHighlight(tool.state.output, pattern) ||
            valueMatchesHighlight(tool.state.error, pattern) ||
            valueMatchesHighlight(tool.state.input, pattern) ||
            valueMatchesHighlight(tool.state.metadata, pattern);
          if (matched) {
            destination.push(
              buildToolItemKey(block.anchorIds?.[partIndex], messageIndex, blockIndex, partIndex),
            );
          }
        }
      }

      if (!isTarget && otherKeys.length >= MAX_NON_TARGET_AUTO_EXPAND) break;
    }
  }

  return [...targetKeys, ...otherKeys.slice(0, MAX_NON_TARGET_AUTO_EXPAND)];
}

export function deriveExpandedSummary(
  messages: FilteredSessionMessage[],
  snapshot: ExpandedItemsSnapshot,
  agent: string,
  directory: string,
): { hasCollapsible: boolean; allExpanded: boolean } {
  let hasCollapsible = false;
  for (const key of collapsibleKeys(messages, agent, directory)) {
    hasCollapsible = true;
    if (snapshot.overrides.size === 0)
      return { hasCollapsible, allExpanded: snapshot.defaultExpanded };
    if (snapshot.defaultExpanded === snapshot.overrides.has(key))
      return { hasCollapsible, allExpanded: false };
  }
  return { hasCollapsible, allExpanded: hasCollapsible };
}

const ExpandedItemsContext = createContext<ExpandedItemsRegistry | null>(null);

export function ExpandedItemsProvider({
  registry,
  children,
}: {
  registry: ExpandedItemsRegistry;
  children: ReactNode;
}) {
  return <ExpandedItemsContext.Provider value={registry}>{children}</ExpandedItemsContext.Provider>;
}

export function useExpandedItem(itemKey: string): [boolean, () => void] {
  const registry = useContext(ExpandedItemsContext);
  const [localExpanded, setLocalExpanded] = useState(false);

  const subscribe = registry ? registry.subscribe : noopSubscribe;
  const getSnapshot = () => (registry ? registry.isExpanded(itemKey) : false);
  const storeExpanded = useSyncExternalStore(subscribe, getSnapshot, () => false);

  const toggle = useCallback(() => {
    if (registry) registry.toggle(itemKey);
    else setLocalExpanded((expanded) => !expanded);
  }, [itemKey, registry]);

  return [registry ? storeExpanded : localExpanded, toggle];
}

export function useExpandedItemsSnapshot(registry: ExpandedItemsRegistry): ExpandedItemsSnapshot {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}
