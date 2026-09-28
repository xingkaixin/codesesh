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
  if (node.error) return t("Worker reported an error. Check its logs.");
  if (!node.lastSeen) return t("Waiting for first connection");
  if (!node.collectionComplete) return t("Collecting history");
  return node.queue?.batches ? t("Connected, uploading") : t("Connected, up to date");
}

export function taskLabel(status: string) {
  const labels: Record<string, string> = {
    waiting: t("Waiting for node"),
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
