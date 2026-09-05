import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { useLayoutEffect, useMemo, useRef } from "react";
import { getSessionAgentKey } from "@codesesh/core/contract";
import type { SessionDetail } from "../lib/api";
import { getSessionDisplayTitle } from "../lib/session-title";
import {
  createInteractiveReceiptSimulation,
  type InteractiveReceiptSimulation,
  type ReceiptLineItem,
  type ReceiptPayload,
} from "./interactive-receipt-simulation";
import type { SessionDetailToc } from "./session-detail/toc";

interface InteractiveReceiptProps {
  session: SessionDetail;
  toc: SessionDetailToc;
  minWidthQuery?: string;
}

function buildReceiptItems(toc: SessionDetailToc): ReceiptLineItem[] {
  const maxItems = 9;
  const baseItems: ReceiptLineItem[] = [
    { label: t("User"), count: toc.counts.user },
    { label: t("Agent Responses"), count: toc.counts.agent_message },
    { label: t("Thinking"), count: toc.counts.thinking },
    { label: t("Plans"), count: toc.counts.plan },
    { label: t("Tools"), count: toc.counts.tools_all },
  ].filter((item) => item.count > 0);
  const toolItems = toc.tools.map((tool) => ({ label: tool.label, count: tool.count }));
  const toolSlots = Math.max(0, maxItems - baseItems.length);
  const visibleToolItems =
    toolItems.length > toolSlots ? toolItems.slice(0, Math.max(0, toolSlots - 1)) : toolItems;
  const hiddenToolCount = toolItems
    .slice(visibleToolItems.length)
    .reduce((total, item) => total + item.count, 0);

  if (hiddenToolCount > 0) {
    visibleToolItems.push({ label: t("Other tools"), count: hiddenToolCount });
  }

  return [...baseItems, ...visibleToolItems].slice(0, maxItems);
}

function formatReceiptSubtitle(tags?: SessionDetail["smart_tags"]) {
  if (!tags || tags.length === 0) return t("SESSION ACTIVITY RECEIPT");
  return tags.map((tag) => t(tag)).join(" / ");
}

function createReceiptPayload(session: SessionDetail, toc: SessionDetailToc): ReceiptPayload {
  return {
    id: session.reference.sessionId,
    title: getSessionDisplayTitle(session) || t("Untitled session"),
    agent: getSessionAgentKey(session),
    updatedAt: session.time_updated ?? session.time_created,
    subtitle: formatReceiptSubtitle(session.smart_tags),
    inputTokens: session.stats.total_input_tokens ?? 0,
    outputTokens: session.stats.total_output_tokens ?? 0,
    messageCount: session.stats.message_count ?? 0,
    totalCost: session.stats.total_cost ?? 0,
    items: buildReceiptItems(toc),
  };
}

export function InteractiveReceipt({
  session,
  toc,
  minWidthQuery = "(min-width: 1025px)",
}: InteractiveReceiptProps) {
  const locale = useLocale();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hitSurfaceRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<InteractiveReceiptSimulation | null>(null);
  const payload = useMemo(
    () => createReceiptPayload(session, toc),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, session, toc],
  );
  const payloadRef = useRef(payload);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const anchor = anchorRef.current;
    const hitSurface = hitSurfaceRef.current;
    if (!canvas || !anchor || !hitSurface) return;

    const simulation = createInteractiveReceiptSimulation({
      canvas,
      anchor,
      hitSurface,
      payload: payloadRef.current,
      minWidthQuery,
    });
    simulationRef.current = simulation;

    return () => {
      simulation?.destroy();
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [minWidthQuery]);

  useLayoutEffect(() => {
    payloadRef.current = payload;
    simulationRef.current?.updatePayload(payload);
  }, [payload]);

  return (
    <div ref={anchorRef} className="relative h-[calc(100dvh-5.5rem)] min-h-[420px]">
      <canvas
        ref={canvasRef}
        className="invisible pointer-events-none absolute inset-0 z-[61] block h-full w-full touch-none"
        aria-hidden="true"
      />
      <div
        ref={hitSurfaceRef}
        className="invisible absolute left-0 top-0 z-[62] cursor-grab touch-none active:cursor-grabbing"
        aria-label={t("Interactive thermal receipt with Verlet paper simulation")}
      />
    </div>
  );
}
