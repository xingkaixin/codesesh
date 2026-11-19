import { useLocale } from "../../hooks/useLocale";
import { useNodeClock, useNodes } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import { cn } from "../../lib/utils";
import { summarizeHubNodes } from "./node-status";

/**
 * Surfaces degraded, offline, or unreachable Hub worker status in the main view
 * whenever the sidebar footer is hidden (collapsed desktop sidebar or narrow viewport).
 */
export function HubStatusNotice({
  sidebarCollapsed,
  onManage,
}: {
  sidebarCollapsed: boolean;
  onManage: () => void;
}) {
  useLocale();
  const nodes = useNodes();
  const now = useNodeClock();
  const summary = summarizeHubNodes(nodes.data?.nodes, now, nodes.isError);

  if (summary.health === "healthy" || summary.health === "loading") return null;

  const isErrorTone = summary.health === "error" || summary.health === "offline";
  const label =
    summary.health === "error"
      ? t("Node status unavailable")
      : t("Source nodes {0}/{1} online", [summary.onlineCount, summary.activeCount]);

  return (
    <div
      role={isErrorTone ? "alert" : "status"}
      className={cn(
        "mt-2 inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-xs",
        isErrorTone
          ? "bg-[var(--console-error-bg)] text-[var(--console-error)] shadow-[inset_0_0_0_1px_var(--console-error-border)]"
          : "bg-[var(--console-warning-bg)] text-[var(--console-warning)] shadow-[inset_0_0_0_1px_var(--console-warning-border)]",
        !sidebarCollapsed && "min-[1025px]:hidden",
      )}
    >
      <span className="console-mono font-medium">{label}</span>
      {summary.attentionCount > 0 ? (
        <span>{t("{0} need attention", [summary.attentionCount])}</span>
      ) : null}
      <button
        type="button"
        onClick={onManage}
        aria-haspopup="dialog"
        className="font-medium underline underline-offset-2 hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Manage")}
      </button>
    </div>
  );
}
