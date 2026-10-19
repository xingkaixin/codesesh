import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionTimelineEntry } from "./timeline";

const TIMELINE_TOOLTIP_VIEWPORT_PADDING = 8;

export interface TimelineTooltip {
  entryId: string;
  id: string;
  text: string;
  anchorX: number;
  top: number;
  source: "focus" | "pointer";
}

export function useSessionMessageTimelineTooltip() {
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [tooltip, setTooltip] = useState<TimelineTooltip | null>(null);

  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element || !tooltip) return;
    const halfWidth = element.offsetWidth / 2;
    const left = Math.min(
      window.innerWidth - TIMELINE_TOOLTIP_VIEWPORT_PADDING - halfWidth,
      Math.max(TIMELINE_TOOLTIP_VIEWPORT_PADDING + halfWidth, tooltip.anchorX),
    );
    element.style.left = `${left}px`;
  }, [tooltip]);

  const show = useCallback(
    (entry: SessionTimelineEntry, trigger: HTMLElement, source: TimelineTooltip["source"]) => {
      const rect = trigger.getBoundingClientRect();
      triggerRef.current = trigger;
      setTooltip({
        entryId: entry.id,
        id: `timeline-tooltip-${entry.id}`,
        text: entry.tooltip,
        anchorX: rect.left + rect.width / 2,
        top: rect.bottom + 8,
        source,
      });
    },
    [],
  );

  const hide = useCallback((entryId: string) => {
    setTooltip((current) => {
      if (current?.entryId !== entryId) return current;
      triggerRef.current = null;
      return null;
    });
  }, []);

  const handleScroll = useCallback(() => {
    setTooltip((current) => {
      const trigger = triggerRef.current;
      if (
        !current ||
        current.source !== "focus" ||
        !trigger ||
        trigger !== document.activeElement
      ) {
        triggerRef.current = null;
        return null;
      }

      const rect = trigger.getBoundingClientRect();
      return {
        ...current,
        anchorX: rect.left + rect.width / 2,
        top: rect.bottom + 8,
      };
    });
  }, []);

  return { tooltip, tooltipRef, show, hide, handleScroll };
}

export function SessionMessageTimelineTooltip({
  tooltip,
  tooltipRef,
}: {
  tooltip: TimelineTooltip | null;
  tooltipRef: RefObject<HTMLSpanElement | null>;
}) {
  if (!tooltip) return null;
  return createPortal(
    <span
      ref={tooltipRef}
      id={tooltip.id}
      role="tooltip"
      className="t-tt session-timeline-floating-tooltip console-mono text-[11px]"
      style={{ left: tooltip.anchorX, top: tooltip.top }}
    >
      {tooltip.text}
    </span>,
    document.body,
  );
}
