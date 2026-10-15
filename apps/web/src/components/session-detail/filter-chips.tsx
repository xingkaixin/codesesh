import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * The active-filter row above the message stream. Chips are the deviation from
 * "everything on", so the row disappears once no tool is filtered out.
 */
import { X } from "../ui/icons";
import { deriveActiveChips, type SessionFilterState } from "./filter-state";
import { TOC_CONTENT_FILTER_IDS, type SessionDetailToc, type TocContentFilterId } from "./toc";
import type { SessionFilterActions } from "./use-session-filters";

const CONTENT_SHORT_LABEL: Record<TocContentFilterId, string> = {
  user: "You",
  agent_message: "Reply",
  thinking: "Thinking",
  plan: "Plan",
};

export function countActiveFilterChips(toc: SessionDetailToc, state: SessionFilterState) {
  return deriveActiveChips(toc, state).length;
}

export function SessionFilterChips({
  toc,
  state,
  actions,
}: {
  toc: SessionDetailToc;
  state: SessionFilterState;
  actions: SessionFilterActions;
}) {
  useLocale();

  const chips = deriveActiveChips(toc, state);
  if (chips.length === 0) return null;

  const contentSummary = TOC_CONTENT_FILTER_IDS.filter(
    (id) => toc.counts[id] > 0 && !state.excluded.has(id),
  ).map((id) => t(CONTENT_SHORT_LABEL[id]));

  return (
    <div className="hidden flex-wrap items-center gap-1.5 min-[1025px]:flex">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex h-[26px] items-center gap-1 rounded-full border border-[var(--console-border)] bg-[var(--console-surface)] pr-1 pl-2.5 text-xs whitespace-nowrap text-[var(--console-muted)]"
        >
          {t("Tool ·")}{" "}
          <b className="console-mono font-medium text-[var(--console-text)]">{chip.label}</b>
          <button
            type="button"
            aria-label={t("Remove filter {0}", [chip.label])}
            onClick={() => actions.toggleTool(chip.id)}
            className="motion-hover inline-flex size-[18px] items-center justify-center rounded-full hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {contentSummary.length > 0 ? (
        <span className="inline-flex h-[26px] items-center rounded-full border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 text-xs whitespace-nowrap text-[var(--console-muted)]">
          + {contentSummary.join(" / ")}
        </span>
      ) : null}
    </div>
  );
}
