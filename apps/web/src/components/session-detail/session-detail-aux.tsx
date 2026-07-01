import { useEffect, useState } from "react";
import { FileText, Funnel, X } from "lucide-react";
import type { SessionData } from "../../lib/api";
import { InteractiveReceipt } from "../InteractiveReceipt";
import { RenderProfiler } from "../RenderProfiler";
import type { SessionDetailToc } from "./toc";
import type { FileChangeSummary } from "./file-change";
import { FileChangeTracker, getFileTrackerItemCount } from "./file-change-tracker";
import { SessionTocFilterPanel } from "./session-toc";

export function DeferredInteractiveReceipt({
  session,
  toc,
}: {
  session: SessionData;
  toc: SessionDetailToc;
}) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [session.id]);

  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }

    setReady(false);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setReady(true));
    });
    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    const closeOnSmallViewport = () => {
      if (!desktopQuery.matches) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    desktopQuery.addEventListener("change", closeOnSmallViewport);
    closeOnSmallViewport();

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      desktopQuery.removeEventListener("change", closeOnSmallViewport);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Open session receipt"
        onClick={() => setOpen(true)}
        className="console-mono fixed right-0 top-1/2 z-40 hidden h-32 w-10 -translate-y-1/2 items-center justify-center rounded-l-sm border border-r-0 border-[var(--console-border)] bg-white text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--console-text)] shadow-[-2px_4px_14px_rgba(15,23,42,0.14)] transition-colors hover:bg-[var(--console-surface-muted)] min-[1025px]:flex"
      >
        <span className="[writing-mode:vertical-rl]">Receipt</span>
      </button>
      {open ? (
        <div className="fixed inset-0 z-[60] hidden min-[1025px]:block">
          <button
            type="button"
            aria-label="Close session receipt"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/20"
          />
          <aside className="absolute right-0 top-0 z-10 h-full w-[min(92vw,430px)] border-l border-[var(--console-border)] bg-[var(--console-bg)] p-4 shadow-[-12px_0_32px_rgba(15,23,42,0.18)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
                Session Receipt
              </span>
              <button
                type="button"
                aria-label="Close session receipt"
                onClick={() => setOpen(false)}
                className="rounded-sm border border-[var(--console-border)] bg-white p-2 text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                <X className="size-4" />
              </button>
            </div>
            {ready ? (
              <RenderProfiler id="InteractiveReceipt">
                <InteractiveReceipt key={session.id} session={session} toc={toc} />
              </RenderProfiler>
            ) : (
              <div className="h-[calc(100dvh-5.5rem)] min-h-[420px] rounded-sm border border-[var(--console-border)] bg-white" />
            )}
          </aside>
        </div>
      ) : null}
    </>
  );
}

export function SessionDetailAuxControls({
  toc,
  fileChangeSummary,
  onOpen,
}: {
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  onOpen: (panel: "toc" | "files") => void;
}) {
  const fileCount = getFileTrackerItemCount(fileChangeSummary);

  return (
    <div className="flex flex-wrap gap-2 min-[1025px]:hidden">
      <button
        type="button"
        onClick={() => onOpen("toc")}
        className="console-mono inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-text)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[var(--console-surface-muted)]"
      >
        <Funnel className="size-3.5 text-[var(--console-accent)]" />
        TOC
        <span className="text-[var(--console-muted)]">{toc.counts.tools_all}</span>
      </button>
      {fileCount > 0 ? (
        <button
          type="button"
          onClick={() => onOpen("files")}
          className="console-mono inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-text)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[var(--console-surface-muted)]"
        >
          <FileText className="size-3.5 text-[var(--console-accent)]" />
          Files
          <span className="text-[var(--console-muted)]">{fileCount}</span>
        </button>
      ) : null}
    </div>
  );
}

export function SessionDetailAuxOverlay({
  openPanel,
  toc,
  fileChangeSummary,
  baseDirectory,
  selectedFilters,
  onClose,
  onToggle,
  onJumpToAnchor,
}: {
  openPanel: "toc" | "files" | null;
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  selectedFilters: Set<string>;
  onClose: () => void;
  onToggle: (filterId: string) => void;
  onJumpToAnchor: (anchorId: string) => void;
}) {
  useEffect(() => {
    if (!openPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    const closeOnDesktop = () => {
      if (desktopQuery.matches) onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    desktopQuery.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      desktopQuery.removeEventListener("change", closeOnDesktop);
    };
  }, [onClose, openPanel]);

  if (!openPanel) return null;

  return (
    <div className="fixed inset-0 z-50 min-[1025px]:hidden">
      <button
        type="button"
        aria-label="Close navigation panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside className="console-scrollbar absolute right-0 top-0 h-full w-[min(90vw,380px)] overflow-y-auto border-l border-[var(--console-border)] bg-[var(--console-bg)] p-3 shadow-[-10px_0_30px_rgba(15,23,42,0.16)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
            {openPanel === "toc" ? "Session TOC" : "File Tracker"}
          </span>
          <button
            type="button"
            aria-label="Close navigation panel"
            onClick={onClose}
            className="rounded-sm border border-[var(--console-border)] bg-white p-2 text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)]"
          >
            <X className="size-4" />
          </button>
        </div>
        {openPanel === "toc" ? (
          <SessionTocFilterPanel toc={toc} selectedFilters={selectedFilters} onToggle={onToggle} />
        ) : (
          <FileChangeTracker
            summary={fileChangeSummary}
            baseDirectory={baseDirectory}
            onJumpToAnchor={onJumpToAnchor}
          />
        )}
      </aside>
    </div>
  );
}
