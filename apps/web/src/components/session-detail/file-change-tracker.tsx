import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FilePenLine,
  FileSearch,
  FileText,
  LoaderCircle,
  NotebookPen,
  XCircle,
} from "lucide-react";
import { Collapsible } from "../ui/Collapsible";
import type { FileChangeKind, FileChangeSummary, FileChangeSummaryItem } from "./file-change";
import { formatTrackedPath } from "./path-extract";
import {
  getActivationScrollBehavior,
  type SessionAnchorScrollBehavior,
  type SessionAnchorScrollHandler,
} from "./scroll-behavior";

export function getFileTrackerItemCount(summary: FileChangeSummary) {
  return summary.read.length + summary.edit.length + summary.write.length + summary.delete.length;
}

export function FileChangeTracker({
  summary,
  baseDirectory,
  onJumpToAnchor,
}: {
  summary: FileChangeSummary;
  baseDirectory: string;
  onJumpToAnchor: SessionAnchorScrollHandler;
}) {
  const sections = [
    { key: "read" as const, label: "Read", Icon: FileSearch, items: summary.read },
    { key: "edit" as const, label: "Edit", Icon: FilePenLine, items: summary.edit },
    { key: "write" as const, label: "Write", Icon: NotebookPen, items: summary.write },
    { key: "delete" as const, label: "Delete", Icon: XCircle, items: summary.delete },
  ].filter((section) => section.items.length > 0) satisfies Array<{
    key: FileChangeKind;
    label: string;
    Icon: typeof LoaderCircle;
    items: FileChangeSummaryItem[];
  }>;

  if (sections.length === 0) return null;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-3">
        <FileText className="size-3.5 text-[var(--console-accent)]" />
        <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          File Tracker
        </span>
      </div>
      <div className="space-y-3 p-3">
        {sections.map(({ key, label, Icon, items }) => (
          <FileTrackerSection
            key={key}
            label={label}
            Icon={Icon}
            items={items}
            baseDirectory={baseDirectory}
            onJumpToAnchor={onJumpToAnchor}
          />
        ))}
      </div>
    </div>
  );
}

function FileTrackerSection({
  label,
  Icon,
  items,
  baseDirectory,
  onJumpToAnchor,
}: {
  label: string;
  Icon: typeof LoaderCircle;
  items: FileChangeSummaryItem[];
  baseDirectory: string;
  onJumpToAnchor: SessionAnchorScrollHandler;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="motion-hover flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--console-surface-muted)]"
      >
        <Icon className="size-3.5 shrink-0 text-[var(--console-accent)]" />
        <span className="console-mono min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--console-muted)]">
          {label}
        </span>
        <span className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]">
          {items.length}
        </span>
        <ChevronDown
          className="motion-chevron size-3.5 shrink-0 text-[var(--console-muted)]"
          data-open={expanded || undefined}
        />
      </button>
      <Collapsible open={expanded}>
        {() => (
          <div className="space-y-1 border-t border-[var(--console-border)] p-2">
            {items.map((item) => (
              <FileTrackerItem
                key={`${item.path}:${item.latestAnchorId || item.latestTime}`}
                item={item}
                baseDirectory={baseDirectory}
                onJumpToAnchor={onJumpToAnchor}
              />
            ))}
          </div>
        )}
      </Collapsible>
    </div>
  );
}

function FileTrackerItem({
  item,
  baseDirectory,
  onJumpToAnchor,
}: {
  item: FileChangeSummaryItem;
  baseDirectory: string;
  onJumpToAnchor: SessionAnchorScrollHandler;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);

  function jumpToIndex(nextIndex: number, behavior: SessionAnchorScrollBehavior) {
    const total = item.anchors.length;
    if (total === 0) return;
    const normalizedIndex = ((nextIndex % total) + total) % total;
    setCurrentIndex(normalizedIndex);
    const anchor = item.anchors[normalizedIndex];
    if (anchor) {
      onJumpToAnchor(anchor.anchorId, behavior);
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-sm px-2 py-2 motion-hover hover:bg-[var(--console-surface-muted)]">
      <button
        type="button"
        title={item.path}
        onClick={(event) => jumpToIndex(currentIndex, getActivationScrollBehavior(event.detail))}
        className="min-w-0 flex-1 text-left"
      >
        <span className="console-mono block break-all text-xs text-[var(--console-text)]">
          {formatTrackedPath(item.path, baseDirectory)}
        </span>
      </button>
      {item.anchors.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Previous ${item.path}`}
            onClick={(event) =>
              jumpToIndex(currentIndex - 1, getActivationScrollBehavior(event.detail))
            }
            className="rounded-sm border border-[var(--console-border)] p-1 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface)]"
          >
            <ChevronUp className="size-3" />
          </button>
          <span className="console-mono text-[10px] text-[var(--console-muted)]">
            {currentIndex + 1}/{item.anchors.length}
          </span>
          <button
            type="button"
            aria-label={`Next ${item.path}`}
            onClick={(event) =>
              jumpToIndex(currentIndex + 1, getActivationScrollBehavior(event.detail))
            }
            className="rounded-sm border border-[var(--console-border)] p-1 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface)]"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Jump to tool call"
          onClick={(event) => jumpToIndex(0, getActivationScrollBehavior(event.detail))}
          className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]"
        >
          {item.count}
        </button>
      )}
    </div>
  );
}
