import { t } from "../../i18n/translate";
import { isNodeOnline } from "../../hooks/useNodes";
import type { SourceNode } from "../../lib/api";

export function nodeStatus(node: SourceNode, now: number) {
  if (node.revoked) return t("Access revoked");
  if (node.lastSeen != null && !isNodeOnline(node, now))
    return t("Offline. Saved history remains available.");
  if (node.error?.includes("WORKER_TOO_NEW"))
    return t("Upgrade Hub first. Collection and uploads are paused.");
  if (node.error?.includes("WORKER_TOO_OLD"))
    return t("Upgrade this Worker. Collection and uploads are paused.");
  if (node.error && !node.error.includes("SOURCE_OR_STORAGE_ERROR"))
    return t("Worker reported an error. Check its logs.");
  if (!node.lastSeen) return t("Waiting for first connection");
  if (!node.collectionComplete) return t("Collecting history");
  return node.queue?.batches ? t("Connected, uploading") : t("Connected, up to date");
}

export function taskLabel(status: string) {
  const labels: Record<string, string> = {
    waiting: t("Waiting for node"),
    dispatched: t("Dispatched to Worker"),
    cancelled: t("Cancelled"),
    running: t("Scanning"),
    uploading: t("Waiting for upload confirmation"),
    paused: t("Paused"),
    failed: t("Failed"),
    completed: t("Completed"),
    partial: t("Source content is missing"),
    superseded: t("Replaced by recovery"),
  };
  return labels[status] ?? status;
}

export function nodeRecoveryHint(node: SourceNode) {
  const error = node.error ?? "";
  if (node.revoked)
    return t("Replace this Worker to restore access while keeping its source identity.");
  if (error.includes("WORKER_TOO_NEW"))
    return t("Upgrade Hub first. Collection and uploads are paused.");
  if (error.includes("WORKER_TOO_OLD"))
    return t("Upgrade this Worker. Collection and uploads are paused.");
  if (error.includes("VERSION") || error.includes("PROTOCOL") || error.includes("PAYLOAD"))
    return t("Install compatible Hub and Worker versions, upgrading Hub first.");
  if (error.includes("INSTANCE"))
    return t("Stop the other Worker using this identity, then wait for its lease to expire.");
  if (error.includes("STREAM") || error.includes("credential") || error.includes("revoked"))
    return t("Check this Worker's Hub binding and credentials. Pair again if access was revoked.");
  if (error.includes("SOURCE_OR_STORAGE_ERROR"))
    return t(
      "Check the affected Agent's source permissions and available disk space on the Worker.",
    );
  if (error)
    return t("Run codesesh worker status on this machine and inspect the reported log paths.");
  return null;
}

export function collectionStatus(node: SourceNode, now: number) {
  const health = node.health;
  if (!health) return t("Collection details unavailable. Upgrade the Worker to report them.");
  if (!isNodeOnline(node, now) || now - health.reportedAt > 60000)
    return t("Last reported state; Worker status may have changed.");
  if (health.collection.activeAgent) return t("Scanning {0}", [health.collection.activeAgent]);
  if (Object.keys(health.collection.errors).length)
    return t("Some Agents failed; other Agents continue collecting.");
  if (node.error || node.revoked) return t("Collection paused or needs attention.");
  return node.collectionComplete ? t("Waiting for the next scan") : t("Collecting history");
}
