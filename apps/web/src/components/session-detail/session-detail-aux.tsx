import { lazy, Suspense, useEffect, useState } from "react";
import { FileText, Funnel } from "../ui/icons";
import type { SessionDetail } from "../../lib/api";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";
import { DrawerDialog } from "../DrawerDialog";
import type { SessionDetailToc } from "./toc";
import type { SessionFilterState } from "./filter-state";
import type { FileChangeSummary } from "./file-change";
import { FileChangeTracker, getFileTrackerItemCount } from "./file-change-tracker";
import type { SessionAnchorScrollHandler } from "./scroll-behavior";
import { SessionFilterPanel, type SessionFilterPanelProps } from "./filter-panel";
import { countActiveFilterChips } from "./filter-chips";

// The receipt is only reachable from its drawer, so it downloads on open.
const InteractiveReceipt = lazy(() =>
  import("../InteractiveReceipt").then((m) => ({ default: m.InteractiveReceipt })),
);

function ReceiptPlaceholder() {
  return (
    <div className="h-[calc(100dvh-5.5rem)] min-h-[420px] rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)]" />
  );
}

export function DeferredInteractiveReceipt({
  session,
  toc,
}: {
  session: SessionDetail;
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
        className="console-mono fixed right-0 top-1/2 z-40 hidden h-32 w-10 -translate-y-1/2 items-center justify-center rounded-l-sm border border-r-0 border-[var(--console-border)] bg-[var(--console-surface)] text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--console-text)] shadow-[var(--shadow-overlay)] motion-hover hover:bg-[var(--console-surface-muted)] min-[1025px]:flex"
      >
        <span className="[writing-mode:vertical-rl]">Receipt</span>
      </button>
      <DrawerDialog open={open} onOpenChange={setOpen} title="Session Receipt" variant="desktop">
        {ready ? (
          <RenderProfiler id="InteractiveReceipt">
            <ErrorBoundary>
              <Suspense fallback={<ReceiptPlaceholder />}>
                <InteractiveReceipt key={session.id} session={session} toc={toc} />
              </Suspense>
            </ErrorBoundary>
          </RenderProfiler>
        ) : (
          <ReceiptPlaceholder />
        )}
      </DrawerDialog>
    </>
  );
}

const AUX_BUTTON_CLASS =
  "console-mono motion-hover inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 text-xs font-semibold tracking-[0.12em] text-[var(--console-text)] uppercase shadow-[var(--shadow-raised)] hover:bg-[var(--console-surface-muted)]";

/** Below 1025px the filter chips collapse into this row: one button that opens
 *  the aside in a drawer, labelled with the number of active tool chips. */
export function SessionDetailAuxControls({
  toc,
  state,
  fileChangeSummary,
  onOpen,
}: {
  toc: SessionDetailToc;
  state: SessionFilterState;
  fileChangeSummary: FileChangeSummary;
  onOpen: (panel: "toc" | "files") => void;
}) {
  const fileCount = getFileTrackerItemCount(fileChangeSummary);
  const chipCount = countActiveFilterChips(toc, state);

  return (
    <div className="flex flex-wrap gap-2 min-[1025px]:hidden">
      <button type="button" onClick={() => onOpen("toc")} className={AUX_BUTTON_CLASS}>
        <Funnel className="size-3.5 text-[var(--brand)]" />
        {chipCount > 0 ? `${chipCount} 项筛选` : "内容筛选"}
      </button>
      {fileCount > 0 ? (
        <button type="button" onClick={() => onOpen("files")} className={AUX_BUTTON_CLASS}>
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
  fileChangeSummary,
  baseDirectory,
  onClose,
  onJumpToAnchor,
  ...panelProps
}: SessionFilterPanelProps & {
  openPanel: "toc" | "files" | null;
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  onClose: () => void;
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
      title={openPanel === "files" ? "File Tracker" : "内容筛选"}
      variant="mobile"
    >
      {openPanel ? (
        openPanel === "toc" ? (
          <SessionFilterPanel {...panelProps} />
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
