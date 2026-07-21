import { useEffect, useState } from "react";
import { FileText, Funnel } from "lucide-react";
import type { SessionData } from "../../lib/api";
import { InteractiveReceipt } from "../InteractiveReceipt";
import { RenderProfiler } from "../RenderProfiler";
import { DrawerDialog } from "../DrawerDialog";
import type { SessionDetailToc } from "./toc";
import type { FileChangeSummary } from "./file-change";
import { FileChangeTracker, getFileTrackerItemCount } from "./file-change-tracker";
import type { SessionAnchorScrollHandler } from "./scroll-behavior";
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
    desktopQuery.addEventListener("change", closeOnSmallViewport);
    closeOnSmallViewport();

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
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
        className="console-mono fixed right-0 top-1/2 z-40 hidden h-32 w-10 -translate-y-1/2 items-center justify-center rounded-l-sm border border-r-0 border-[var(--console-border)] bg-[var(--console-surface)] text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--console-text)] shadow-[-2px_4px_14px_rgba(15,23,42,0.14)] transition-colors hover:bg-[var(--console-surface-muted)] min-[1025px]:flex"
      >
        <span className="[writing-mode:vertical-rl]">Receipt</span>
      </button>
      <DrawerDialog open={open} onOpenChange={setOpen} title="Session Receipt" variant="desktop">
        {ready ? (
          <RenderProfiler id="InteractiveReceipt">
            <InteractiveReceipt key={session.id} session={session} toc={toc} />
          </RenderProfiler>
        ) : (
          <div className="h-[calc(100dvh-5.5rem)] min-h-[420px] rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)]" />
        )}
      </DrawerDialog>
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
        className="console-mono inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-text)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[var(--console-surface-muted)]"
      >
        <Funnel className="size-3.5 text-[var(--console-accent)]" />
        TOC
        <span className="text-[var(--console-muted)]">{toc.counts.tools_all}</span>
      </button>
      {fileCount > 0 ? (
        <button
          type="button"
          onClick={() => onOpen("files")}
          className="console-mono inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-text)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[var(--console-surface-muted)]"
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
  onJumpToAnchor: SessionAnchorScrollHandler;
}) {
  useEffect(() => {
    if (!openPanel) return;
    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    const closeOnDesktop = () => {
      if (desktopQuery.matches) onClose();
    };
    desktopQuery.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => {
      desktopQuery.removeEventListener("change", closeOnDesktop);
    };
  }, [onClose, openPanel]);

  return (
    <DrawerDialog
      open={openPanel !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={openPanel === "files" ? "File Tracker" : "Session TOC"}
      variant="mobile"
    >
      {openPanel ? (
        openPanel === "toc" ? (
          <SessionTocFilterPanel toc={toc} selectedFilters={selectedFilters} onToggle={onToggle} />
        ) : (
          <FileChangeTracker
            summary={fileChangeSummary}
            baseDirectory={baseDirectory}
            onJumpToAnchor={onJumpToAnchor}
          />
        )
      ) : null}
    </DrawerDialog>
  );
}
