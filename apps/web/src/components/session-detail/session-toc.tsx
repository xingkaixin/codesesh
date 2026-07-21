import { useLayoutEffect, useRef } from "react";
import { Check, Funnel, Minus } from "lucide-react";
import type { SessionDetailToc, TocFilterId } from "./toc";
import type { FileChangeSummary } from "./file-change";
import { FileChangeTracker } from "./file-change-tracker";
import type { SessionAnchorScrollHandler } from "./scroll-behavior";

const TOC_META: Array<{ id: TocFilterId; label: string }> = [
  { id: "user", label: "User" },
  { id: "agent_message", label: "Agent Responses" },
  { id: "thinking", label: "Thinking" },
  { id: "plan", label: "Plans" },
  { id: "tools_all", label: "Tools" },
];

function getTocToolIds(toc: SessionDetailToc) {
  return toc.tools.map((tool) => tool.id);
}

export function toggleTocFilter(
  currentFilters: Set<string>,
  filterId: string,
  toc: SessionDetailToc,
) {
  const next = new Set(currentFilters);
  const toolIds = getTocToolIds(toc);

  if (filterId === "tools_all") {
    const selectedToolCount = toolIds.filter((id) => next.has(id)).length;
    const shouldSelectAllTools = selectedToolCount < toolIds.length;
    if (shouldSelectAllTools) {
      next.add("tools_all");
      for (const toolId of toolIds) next.add(toolId);
    } else {
      next.delete("tools_all");
      for (const toolId of toolIds) next.delete(toolId);
    }
    return next;
  }

  if (filterId.startsWith("tool:")) {
    if (next.has(filterId)) {
      next.delete(filterId);
    } else {
      next.add(filterId);
    }

    const selectedToolCount = toolIds.filter((id) => next.has(id)).length;
    if (selectedToolCount === toolIds.length) {
      next.add("tools_all");
    } else {
      next.delete("tools_all");
    }
    return next;
  }

  if (next.has(filterId)) {
    next.delete(filterId);
  } else {
    next.add(filterId);
  }
  return next;
}

function TocCheckbox({
  checked,
  indeterminate = false,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className="relative mt-0.5 size-3.5 shrink-0">
      <input
        ref={checkboxRef}
        type="checkbox"
        checked={checked}
        aria-checked={indeterminate ? "mixed" : checked}
        data-indeterminate={indeterminate ? "true" : undefined}
        onChange={onChange}
        className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className={`flex size-3.5 items-center justify-center rounded border ${
          checked || indeterminate
            ? "border-[var(--console-accent-strong)] bg-[var(--console-accent-strong)] text-white dark:text-[var(--console-bg)]"
            : "border-[var(--console-border-strong)] bg-[var(--console-surface)] text-transparent"
        }`}
      >
        {indeterminate ? (
          <Minus className="size-2.5 stroke-[3]" />
        ) : checked ? (
          <Check className="size-2.5 stroke-[3]" />
        ) : null}
      </span>
    </span>
  );
}

export function SessionToc({
  toc,
  fileChangeSummary,
  baseDirectory,
  selectedFilters,
  onToggle,
  onJumpToAnchor,
}: {
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  selectedFilters: Set<string>;
  onToggle: (filterId: string) => void;
  onJumpToAnchor: SessionAnchorScrollHandler;
}) {
  return (
    <aside className="console-scrollbar hidden min-[1025px]:sticky min-[1025px]:top-4 min-[1025px]:block min-[1025px]:max-h-[calc(100dvh-14rem)] min-[1025px]:overflow-y-auto min-[1025px]:overscroll-contain">
      <div className="space-y-4">
        <SessionTocFilterPanel toc={toc} selectedFilters={selectedFilters} onToggle={onToggle} />
        <FileChangeTracker
          summary={fileChangeSummary}
          baseDirectory={baseDirectory}
          onJumpToAnchor={onJumpToAnchor}
        />
      </div>
    </aside>
  );
}

export function SessionTocFilterPanel({
  toc,
  selectedFilters,
  onToggle,
}: {
  toc: SessionDetailToc;
  selectedFilters: Set<string>;
  onToggle: (filterId: string) => void;
}) {
  const toolIds = getTocToolIds(toc);
  const selectedToolCount = toolIds.filter((id) => selectedFilters.has(id)).length;
  const allToolsSelected = toolIds.length > 0 && selectedToolCount === toolIds.length;
  const someToolsSelected = selectedToolCount > 0 && selectedToolCount < toolIds.length;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-3">
        <Funnel className="size-3.5 text-[var(--console-accent)]" />
        <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          Session TOC
        </span>
      </div>
      <div className="space-y-1 p-3">
        {TOC_META.filter(({ id }) => toc.counts[id] > 0).map(({ id, label }) => (
          <label
            key={id}
            className="flex cursor-pointer items-start gap-3 rounded-sm px-2 py-2 motion-hover hover:bg-[var(--console-surface-muted)]"
          >
            <TocCheckbox
              checked={id === "tools_all" ? allToolsSelected : selectedFilters.has(id)}
              indeterminate={id === "tools_all" ? someToolsSelected : false}
              onChange={() => onToggle(id)}
            />
            <span className="console-mono min-w-0 flex-1 break-all text-xs leading-relaxed text-[var(--console-text)]">
              {label}
            </span>
            <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
              {toc.counts[id]}
            </span>
          </label>
        ))}
        {toc.tools.length > 0 ? (
          <div className="space-y-1 border-t border-[var(--console-border)] pt-2">
            {toc.tools.map((tool) => (
              <label
                key={tool.id}
                className="flex cursor-pointer items-start gap-3 rounded-sm px-2 py-2 motion-hover hover:bg-[var(--console-surface-muted)]"
              >
                <TocCheckbox
                  checked={selectedFilters.has(tool.id)}
                  onChange={() => onToggle(tool.id)}
                />
                <span className="console-mono min-w-0 flex-1 break-all text-xs leading-relaxed text-[var(--console-text)]">
                  {tool.label}
                </span>
                <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
                  {tool.count}
                </span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
