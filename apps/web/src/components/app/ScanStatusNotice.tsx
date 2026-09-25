import { useLocale } from "../../hooks/useLocale";
import { useState } from "react";
import { useScanStatus } from "../../hooks/useScanStatus";
import { formatScanStatusLabel } from "../../lib/scan-format";

export function ScanStatusNotice({ visible }: { visible: boolean }) {
  useLocale();

  const scanStatus = useScanStatus();
  const label = formatScanStatusLabel(scanStatus);
  const progress = scanStatus?.backfill.active ? scanStatus.backfill.progress : undefined;
  const total = progress?.total;
  const processed = progress?.processed;
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
      <div className={visible && label ? "flow-root" : undefined}>
        {visible && label ? (
          <div
            title={label}
            className="console-mono mt-2 w-fit max-w-full rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--console-warning)]"
          >
            <p>{label}</p>
            {total != null && total > 0 && processed != null ? (
              <div
                role="progressbar"
                aria-label={label}
                aria-valuenow={Math.min(processed, total)}
                aria-valuemin={0}
                aria-valuemax={total}
                className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-[var(--console-warning-border)]"
              >
                <div
                  className="h-full bg-[var(--console-warning)]"
                  style={{ width: `${Math.min(100, (processed / total) * 100)}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <ScanStatusAnnouncement key={milestoneKey ?? "idle"} visible={visible} label={label} />
    </>
  );
}

function ScanStatusAnnouncement({ visible, label }: { visible: boolean; label: string | null }) {
  useLocale();

  const [announcedLabel] = useState(label);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {visible ? announcedLabel : null}
    </div>
  );
}
