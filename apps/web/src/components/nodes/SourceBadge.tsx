import type { SourceNode } from "../../lib/api";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";

export function sourceName(sourceNodeId: string, nodes?: SourceNode[]) {
  return sourceNodeId === "local"
    ? t("Local source")
    : (nodes?.find((node) => node.id === sourceNodeId)?.name ?? sourceNodeId);
}

export function SourceBadge({
  sourceNodeId,
  nodes,
}: {
  sourceNodeId: string;
  nodes?: SourceNode[];
}) {
  useLocale();
  return (
    <span
      className="break-all text-xs text-[var(--console-muted)]"
      title={sourceNodeId === "local" ? undefined : sourceNodeId}
    >
      {t("Source: {0}", [sourceName(sourceNodeId, nodes)])}
    </span>
  );
}
