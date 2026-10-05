import { Popover } from "@base-ui/react/popover";
import { t } from "../../i18n/translate";
import { CollectionSources } from "../collection-status";
import { X } from "../ui/icons";
import { useLocale } from "../../hooks/useLocale";
import { useState } from "react";
import { useScanStatus } from "../../hooks/useScanStatus";
import { formatScanStatusLabel } from "../../lib/scan-format";

export function ScanStatusNotice({ visible }: { visible: boolean }) {
  useLocale();

  const scanStatus = useScanStatus();
  const label = formatScanStatusLabel(scanStatus);
  const hasSources = scanStatus?.sources != null;
  const sourceIssue = Object.values(scanStatus?.sources ?? {}).some(
    (source) => source.error || source.presence === "missing",
  );
  const triggerLabel =
    label ?? (sourceIssue ? t("Some sources need attention") : t("Local collection"));
  const show = visible && (label != null || hasSources);
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
      <div className={show ? "flow-root" : undefined}>
        {show ? (
          <Popover.Root>
            <Popover.Trigger
              className={`console-mono mt-2 block w-fit max-w-full rounded-sm border px-2 py-1 text-left text-[11px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${label || sourceIssue ? "border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] text-[var(--console-warning)]" : "border-border bg-muted text-muted-foreground hover:text-foreground"}`}
            >
              <span>{triggerLabel}</span>
              <span className="ml-2 underline underline-offset-2">{t("View status")}</span>
              {total != null && total > 0 && processed != null ? (
                <div
                  role="progressbar"
                  aria-label={triggerLabel}
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
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={8} align="start" className="z-50">
                <Popover.Popup className="console-scrollbar max-h-[min(32rem,var(--available-height))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-[var(--shadow-overlay)] focus:outline-none">
                  <div className="flex items-center justify-between gap-3">
                    <Popover.Title className="console-display text-sm font-semibold">
                      {t("Local collection")}
                    </Popover.Title>
                    <Popover.Close
                      aria-label={t("Close")}
                      className="rounded-sm p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Popover.Close>
                  </div>
                  <Popover.Description className="mb-2 mt-1 text-xs text-muted-foreground">
                    {t("Available history remains searchable.")}
                  </Popover.Description>
                  <CollectionSources sources={scanStatus?.sources} />
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
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
