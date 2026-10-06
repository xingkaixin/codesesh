import { useLocale } from "../../hooks/useLocale";
import { isNodeOnline, useNodeClock, useNodes } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import { XCircle } from "../ui/icons";
import { nodeNeedsAttention } from "./node-status";

export function NodeStatusButton({ onClick }: { onClick: () => void }) {
  useLocale();
  const nodes = useNodes();
  const now = useNodeClock();
  const active = nodes.data?.nodes.filter((node) => !node.revoked) ?? [];
  const online = active.filter((node) => isNodeOnline(node, now)).length;
  const errors = active.filter(nodeNeedsAttention).length;
  const unavailable = nodes.isError;
  const summary = unavailable
    ? t("Node status unavailable")
    : nodes.data
      ? t("{0} online / {1} paired Workers; {2} need attention", [online, active.length, errors])
      : t("Loading…");
  return (
    <button
      type="button"
      onClick={onClick}
      title={summary}
      aria-label={`${t("Source nodes")}: ${summary}`}
      aria-haspopup="dialog"
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border border-[var(--console-border)] px-2 py-1 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${unavailable || errors || online < active.length ? "bg-[var(--console-warning)]" : online ? "bg-[var(--console-success)]" : "bg-[var(--console-muted)]"}`}
      />
      {t("Source nodes")}
      <span className="console-mono tabular-nums">
        {unavailable ? "?" : nodes.data ? t("{0}/{1} online", [online, active.length]) : "…"}
      </span>
      {errors > 0 && !unavailable && (
        <XCircle aria-hidden="true" className="size-3.5 text-[var(--console-warning)]" />
      )}
    </button>
  );
}
