/**
 * The reader's content-filter aside: four content kinds, a collapsible tool
 * group with a name filter and quick actions, and a live 当前视图 summary.
 */
import type * as React from "react";

import { ChevronDown, ChevronRight } from "../ui/icons";
import { TriStateCheckbox, type CheckState } from "../ui/tri-state-checkbox";
import { FileChangeTracker } from "./file-change-tracker";
import type { FileChangeSummary } from "./file-change";
import {
  countSelectedTools,
  deriveHiddenTools,
  deriveToolsParentState,
  deriveVisibleTools,
  type SessionFilterState,
} from "./filter-state";
import type { SessionAnchorScrollHandler } from "./scroll-behavior";
import { TOC_CONTENT_FILTER_IDS, type SessionDetailToc, type TocContentFilterId } from "./toc";
import type { SessionFilterActions } from "./use-session-filters";

const CONTENT_LABEL: Record<TocContentFilterId, string> = {
  user: "你的消息",
  agent_message: "Agent 回复",
  thinking: "思考过程",
  plan: "计划 Plan",
};

const PARENT_CHECK_STATE: Record<ReturnType<typeof deriveToolsParentState>, CheckState> = {
  all: "checked",
  none: "unchecked",
  partial: "indeterminate",
};

export interface SessionFilterPanelProps {
  toc: SessionDetailToc;
  state: SessionFilterState;
  actions: SessionFilterActions;
  visibleUnitCount: number;
}

export function SessionFilterPanel({
  toc,
  state,
  actions,
  visibleUnitCount,
}: SessionFilterPanelProps) {
  const hiddenTools = deriveHiddenTools(toc, state);

  return (
    <section
      aria-label="内容筛选"
      className="flex flex-col rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)]"
    >
      <div className="flex items-center gap-3 border-b border-[var(--console-border)] px-3 py-2.5">
        <span className="console-eyebrow">内容筛选</span>
        <button
          type="button"
          onClick={actions.resetAll}
          className="console-mono motion-hover ml-auto rounded-sm px-1 text-[10.5px] text-[var(--brand)] hover:text-[var(--brand-hover)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          重置
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div className="flex flex-col gap-0.5">
          {TOC_CONTENT_FILTER_IDS.filter((id) => toc.counts[id] > 0).map((id) => (
            <div key={id} className="flex items-center gap-2.5 rounded-sm px-1 py-1">
              <TriStateCheckbox
                size={15}
                label={CONTENT_LABEL[id]}
                state={state.selected.has(id) ? "checked" : "unchecked"}
                onToggle={() => actions.toggleContentKind(id)}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--console-text)]">
                {CONTENT_LABEL[id]}
              </span>
              <span className="console-mono shrink-0 text-[10.5px] text-[var(--console-muted)]">
                {toc.counts[id]}
              </span>
            </div>
          ))}
        </div>

        {toc.tools.length > 0 ? <ToolGroup toc={toc} state={state} actions={actions} /> : null}

        <div className="mt-auto rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-2.5">
          <span className="console-eyebrow">当前视图</span>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--console-text-secondary)]">
            显示 <b className="console-mono text-[var(--console-text)]">{visibleUnitCount}</b> /{" "}
            <span className="console-mono">{toc.totalUnitCount}</span> 条
            {hiddenTools.length > 0
              ? ` · 隐藏了 ${hiddenTools.map((tool) => tool.label).join("、")}`
              : null}
          </p>
        </div>
      </div>
    </section>
  );
}

function ToolGroup({
  toc,
  state,
  actions,
}: {
  toc: SessionDetailToc;
  state: SessionFilterState;
  actions: SessionFilterActions;
}) {
  const parentState = deriveToolsParentState(toc, state);
  const visibleTools = deriveVisibleTools(toc, state);
  const Caret = state.toolsExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="overflow-hidden rounded-md border border-[var(--brand-line)]">
      <div className="flex items-center gap-2.5 bg-[var(--brand-soft)] px-2.5 py-2">
        <TriStateCheckbox
          size={15}
          label="全部工具"
          state={PARENT_CHECK_STATE[parentState]}
          onToggle={() => actions.setAllTools(parentState !== "all")}
        />
        <button
          type="button"
          aria-expanded={state.toolsExpanded}
          onClick={actions.toggleToolsExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          <span className="text-[13px] text-[var(--console-text)]">工具</span>
          <span className="console-mono ml-auto text-[10.5px] text-[var(--console-muted)]">
            {countSelectedTools(toc, state)} / {toc.tools.length} 选中
          </span>
          <Caret className="size-3.5 shrink-0 text-[var(--console-muted)]" />
        </button>
      </div>

      {state.toolsExpanded ? (
        <div className="flex flex-col gap-1.5 bg-[var(--console-surface)] p-2.5">
          <input
            type="search"
            value={state.toolQuery}
            aria-label="过滤工具名"
            placeholder="过滤工具名…"
            onChange={(event) => actions.setToolQuery(event.target.value)}
            className="console-mono w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          />
          {visibleTools.map((tool) => (
            <div key={tool.id} className="flex items-center gap-2 px-0.5">
              <TriStateCheckbox
                size={14}
                label={tool.label}
                state={state.selected.has(tool.id) ? "checked" : "unchecked"}
                onToggle={() => actions.toggleTool(tool.id)}
              />
              <span className="console-mono min-w-0 flex-1 truncate text-xs text-[var(--console-text)]">
                {tool.label}
              </span>
              <span
                aria-hidden="true"
                className="h-1 w-[34px] shrink-0 overflow-hidden rounded-[2px] bg-[var(--console-surface-sunken)]"
              >
                <span
                  className="block h-full rounded-[2px] bg-[var(--brand)]"
                  style={{ width: `${(tool.count / toc.maxToolCount) * 100}%` }}
                />
              </span>
              <span className="console-mono w-5 shrink-0 text-right text-[10px] text-[var(--console-muted)]">
                {tool.count}
              </span>
            </div>
          ))}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <QuickAction onClick={() => actions.setAllTools(true)}>
              全选（当前 {visibleTools.length} 项）
            </QuickAction>
            <QuickAction onClick={() => actions.setAllTools(false)}>
              全不选（当前 {visibleTools.length} 项）
            </QuickAction>
            <QuickAction onClick={actions.selectWriteToolsOnly}>只看写操作</QuickAction>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuickAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="console-mono motion-hover rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-[3px] text-[10px] text-[var(--console-text-secondary)] hover:border-[var(--brand-line)] hover:text-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

export function SessionFilterAside({
  fileChangeSummary,
  baseDirectory,
  onJumpToAnchor,
  ...panelProps
}: SessionFilterPanelProps & {
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  onJumpToAnchor: SessionAnchorScrollHandler;
}) {
  return (
    <aside className="console-scrollbar hidden min-[1025px]:sticky min-[1025px]:top-4 min-[1025px]:block min-[1025px]:max-h-[calc(100dvh-14rem)] min-[1025px]:overflow-y-auto min-[1025px]:overscroll-contain">
      <div className="space-y-4">
        <SessionFilterPanel {...panelProps} />
        <FileChangeTracker
          summary={fileChangeSummary}
          baseDirectory={baseDirectory}
          onJumpToAnchor={onJumpToAnchor}
        />
      </div>
    </aside>
  );
}
