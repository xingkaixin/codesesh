import { useState } from "react";
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
  return (
    <>
      <div className={visible ? "flow-root h-9" : undefined}>
        {visible && label ? (
          <p
            title={label}
            className="console-mono mt-2 w-fit max-w-full truncate rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--console-warning)]"
          >
            {label}
          </p>
        ) : null}
      </div>
      <ScanStatusAnnouncement key={milestoneKey ?? "idle"} visible={visible} label={label} />
    </>
  );
}

function ScanStatusAnnouncement({ visible, label }: { visible: boolean; label: string | null }) {
  const [announcedLabel] = useState(label);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {visible ? announcedLabel : null}
    </div>
  );
}
