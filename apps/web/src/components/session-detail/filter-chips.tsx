/**
 * The active-filter row above the message stream. Chips are the deviation from
 * "everything on", so the row disappears once no tool is filtered out.
 */
import { X } from "../ui/icons";
import { deriveActiveChips, type SessionFilterState } from "./filter-state";
import { TOC_CONTENT_FILTER_IDS, type SessionDetailToc, type TocContentFilterId } from "./toc";
import type { SessionFilterActions } from "./use-session-filters";

const CONTENT_SHORT_LABEL: Record<TocContentFilterId, string> = {
  user: "你",
  agent_message: "回复",
  thinking: "思考",
  plan: "计划",
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
  const chips = deriveActiveChips(toc, state);
  if (chips.length === 0) return null;

  const contentSummary = TOC_CONTENT_FILTER_IDS.filter(
    (id) => toc.counts[id] > 0 && state.selected.has(id),
  ).map((id) => CONTENT_SHORT_LABEL[id]);

  return (
    <div className="hidden flex-wrap items-center gap-1.5 min-[1025px]:flex">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="console-mono inline-flex items-center gap-1 rounded-full bg-[var(--brand)] px-2.5 py-[3px] text-[10.5px] text-[var(--brand-fg)]"
        >
          工具 · {chip.label}
          <button
            type="button"
            aria-label={`移除筛选 ${chip.label}`}
            onClick={() => actions.toggleTool(chip.id)}
            className="motion-hover -mr-1 rounded-full p-0.5 opacity-80 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--brand-fg)] focus-visible:outline-none"
          >
            <X className="size-2.5 stroke-[3]" />
          </button>
        </span>
      ))}
      {contentSummary.length > 0 ? (
        <span className="console-mono inline-flex items-center rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2.5 py-[3px] text-[10.5px] text-[var(--console-muted)]">
          + {contentSummary.join(" / ")}
        </span>
      ) : null}
    </div>
  );
}
