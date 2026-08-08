import { useRef } from "react";
import { useScanStatus } from "../../hooks/useScanStatus";
import { formatScanStatusLabel } from "../../lib/scan-format";

export function ScanStatusNotice({ visible }: { visible: boolean }) {
  const scanStatus = useScanStatus();
  const label = formatScanStatusLabel(scanStatus);
  const milestoneKey = scanStatus
    ? [
        scanStatus.phase,
        scanStatus.scanningAgents[0] ?? "",
        scanStatus.completedAgents.length,
        scanStatus.totalAgents,
        scanStatus.backfill.active,
        scanStatus.backfill.currentAgent ?? "",
        scanStatus.backfill.pendingAgents.length,
        scanStatus.backfill.failedAgents.length,
      ].join("|")
    : null;
  const announced = useRef({ milestoneKey, label });
  if (announced.current.milestoneKey !== milestoneKey) {
    announced.current = { milestoneKey, label };
  }

  return (
    <>
      <div>
        {visible && label ? (
          <p className="console-mono mt-2 inline-flex max-w-4xl rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--console-warning)]">
            {label}
          </p>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {visible ? announced.current.label : null}
      </div>
    </>
  );
}
