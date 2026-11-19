import { useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import { useScanStatus } from "../../hooks/useScanStatus";
import { t } from "../../i18n/translate";
import { formatScanStatusLabel, hasScanStatusIssue } from "../../lib/scan-format";

function MilestoneLabel({ label }: { label: string | null }) {
  const [announcedLabel] = useState(label);
  return announcedLabel;
}

export function ScanStatusAnnouncement({
  visible,
  issuesOnly,
}: {
  visible: boolean;
  issuesOnly: boolean;
}) {
  const locale = useLocale();
  const status = useScanStatus();
  let announcement = null;
  if (visible && status) {
    const label = formatScanStatusLabel(status, issuesOnly);
    const issueLabel = hasScanStatusIssue(status)
      ? (formatScanStatusLabel(status, true) ?? t("Some sources need attention"))
      : null;
    if (issuesOnly || (issueLabel !== null && (label === null || label === issueLabel))) {
      announcement = issueLabel;
    } else {
      const milestone = [
        locale,
        status.phase,
        status.scanningAgents[0],
        status.completedAgents.length,
        status.totalAgents,
        status.backfill.active,
        status.backfill.currentAgent,
        status.backfill.pendingAgents.length,
        status.backfill.failedAgents.length,
      ].join("|");
      announcement = <MilestoneLabel key={milestone} label={label} />;
    }
  }
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  );
}
