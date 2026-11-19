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

export interface ExpandedItemsSnapshot {
  readonly defaultExpanded: boolean;
  readonly overrides: ReadonlySet<string>;
}

export interface ExpandedItemsRegistry {
  readonly sessionKey: string;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
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
