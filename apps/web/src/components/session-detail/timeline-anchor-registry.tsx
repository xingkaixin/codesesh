import { createContext, useCallback, useContext, type ReactNode, type RefCallback } from "react";

type AnchorListener = (
  anchorId: string,
  element: HTMLElement | null,
  previous: HTMLElement | undefined,
) => void;

export interface TimelineAnchorRegistry {
  get: (anchorId: string) => HTMLElement | undefined;
  entries: () => IterableIterator<[string, HTMLElement]>;
  register: (anchorId: string, element: HTMLElement | null) => void;
  subscribe: (listener: AnchorListener) => () => void;
}

export function createTimelineAnchorRegistry(): TimelineAnchorRegistry {
  const anchors = new Map<string, HTMLElement>();
  const listeners = new Set<AnchorListener>();

  return {
    get: (anchorId) => anchors.get(anchorId),
    entries: () => anchors.entries(),
    register: (anchorId, element) => {
      const previous = anchors.get(anchorId);
      if (previous === element || (!previous && !element)) return;
      if (element) anchors.set(anchorId, element);
      else anchors.delete(anchorId);
      listeners.forEach((listener) => listener(anchorId, element, previous));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const TimelineAnchorRegistryContext = createContext<TimelineAnchorRegistry | null>(null);

export function TimelineAnchorRegistryProvider({
  registry,
  children,
}: {
  registry: TimelineAnchorRegistry;
  children: ReactNode;
}) {
  return (
    <TimelineAnchorRegistryContext.Provider value={registry}>
      {children}
    </TimelineAnchorRegistryContext.Provider>
  );
}

export function useTimelineAnchorRef(anchorId?: string): RefCallback<HTMLElement> {
  const registry = useContext(TimelineAnchorRegistryContext);
  return useCallback(
    (element) => {
      if (anchorId) registry?.register(anchorId, element);
    },
    [anchorId, registry],
  );
}
