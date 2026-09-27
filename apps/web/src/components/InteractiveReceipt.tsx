import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionDetail } from "../lib/api";
import { createReceiptPayload, receiptHeight } from "./receipt-data";
import {
  createInteractiveReceiptSimulation,
  type InteractiveReceiptSimulation,
} from "./interactive-receipt-simulation";

interface InteractiveReceiptProps {
  session: SessionDetail;
  minWidthQuery?: string;
}

export function InteractiveReceipt({
  session,
  minWidthQuery = "(min-width: 1025px)",
}: InteractiveReceiptProps) {
  const locale = useLocale();
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hitSurfaceRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<InteractiveReceiptSimulation | null>(null);
  const payload = useMemo(
    () => createReceiptPayload(session),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, session],
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
      onReady: () => setReady(true),
      onError: () => setExportError(true),
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

  const saveImage = async () => {
    const simulation = simulationRef.current;
    if (!simulation || saving) return;
    setSaving(true);
    setExportError(false);
    try {
      const blob = await simulation.exportPng();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const id = session.reference.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
      link.download = `codesesh-receipt-${id}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          disabled={!ready || saving}
          onClick={saveImage}
          className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t("Saving image…") : t("Save image")}
        </button>
      </div>
      {exportError && (
        <p role="alert" className="mb-2 text-xs text-[var(--console-text-secondary)]">
          {t("Could not save receipt image. Reopen the receipt to retry.")}
        </p>
      )}
      <div
        className="console-scrollbar h-[calc(100dvh-8.5rem)] overflow-y-auto"
        tabIndex={0}
        role="region"
        aria-label={t("Session Receipt")}
      >
        <div className="sr-only">
          <h2>{payload.title}</h2>
          <dl>
            {payload.items.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.count}</dd>
              </div>
            ))}
          </dl>
          {[
            ...payload.models,
            {
              name: t("Session total"),
              provider: "",
              rows: payload.rows,
              cost: payload.totalCost,
              estimated: payload.estimated,
            },
          ].map((model) => (
            <table key={`${model.name}/${model.provider}`}>
              <caption>
                {model.name} {model.provider}
              </caption>
              <thead>
                <tr>
                  <th>{t("Usage")}</th>
                  <th>{t("Tokens")}</th>
                  <th>{t("Cost")} (USD)</th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <tr key={row.label}>
                    <th>{row.label}</th>
                    <td>{row.tokens ?? "—"}</td>
                    <td>{row.cost ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{model.estimated ? t("Estimated subtotal") : t("Subtotal")}</th>
                  <td />
                  <td>{model.cost ?? "—"}</td>
                </tr>
              </tfoot>
            </table>
          ))}
          <p>
            {t("Total tokens")}: {payload.totalTokens}
          </p>
          <p>{t("Cache is included in input; counted once.")}</p>
          {payload.missingCosts && <p>{t("— Price breakdown unavailable")}</p>}
        </div>
        <div ref={anchorRef} className="relative" style={{ height: receiptHeight(payload) + 64 }}>
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
      </div>
    </>
  );
}
