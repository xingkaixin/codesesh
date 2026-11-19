import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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

export function deriveExpandedSummary(
  messages: FilteredSessionMessage[],
  snapshot: ExpandedItemsSnapshot,
): { hasCollapsible: boolean; allExpanded: boolean } {
  let hasCollapsible = false;

  if (snapshot.overrides.size === 0) {
    for (const { blocks } of messages) {
      for (const block of blocks) {
        if (block.type === "reasoning" || block.type === "plan" || block.type === "tool") {
          return { hasCollapsible: true, allExpanded: snapshot.defaultExpanded };
        }
      }
    }
    return { hasCollapsible: false, allExpanded: false };
  }

  let allExpanded = true;
  for (const { blocks, index: messageIndex } of messages) {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]!;
      if (block.type === "reasoning") {
        hasCollapsible = true;
        const key = buildReasoningItemKey(buildBlockTimelineAnchorId(messageIndex, blockIndex));
        const expanded = snapshot.defaultExpanded
          ? !snapshot.overrides.has(key)
          : snapshot.overrides.has(key);
        if (!expanded) allExpanded = false;
      } else if (block.type === "plan") {
        const anchorId = buildBlockTimelineAnchorId(messageIndex, blockIndex);
        for (let planIndex = 0; planIndex < block.parts.length; planIndex += 1) {
          hasCollapsible = true;
          const key = buildPlanItemKey(anchorId, planIndex);
          const expanded = snapshot.defaultExpanded
            ? !snapshot.overrides.has(key)
            : snapshot.overrides.has(key);
          if (!expanded) allExpanded = false;
        }
      } else if (block.type === "tool") {
        for (let partIndex = 0; partIndex < block.parts.length; partIndex += 1) {
          hasCollapsible = true;
          const key = buildToolItemKey(
            block.anchorIds?.[partIndex],
            messageIndex,
            blockIndex,
            partIndex,
          );
          const expanded = snapshot.defaultExpanded
            ? !snapshot.overrides.has(key)
            : snapshot.overrides.has(key);
          if (!expanded) allExpanded = false;
        }
      }
      if (hasCollapsible && !allExpanded) return { hasCollapsible: true, allExpanded: false };
    }
  }

  return { hasCollapsible, allExpanded: hasCollapsible && allExpanded };
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
