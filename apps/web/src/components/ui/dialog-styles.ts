export const DIALOG_POPUP_CLASS =
  "motion-modal fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[16px] border border-[var(--console-border)] bg-[var(--console-surface)] text-[var(--console-text)] shadow-[var(--shadow-overlay)] outline-none";
export const DIALOG_HEADER_CLASS = "flex items-start justify-between gap-4 px-6 pt-5 pb-3";
export const DIALOG_TITLE_CLASS = "text-base font-semibold text-[var(--console-text)]";
export const DIALOG_DESCRIPTION_CLASS = "mt-1 text-xs text-[var(--console-muted)]";
export const DIALOG_BODY_CLASS = "flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-2 pb-4";
export const DIALOG_FOOTER_CLASS =
  "flex items-center justify-end gap-2 border-t border-[var(--console-border)] bg-[var(--console-bg)] px-6 py-3.5";

const BUTTON_BASE_CLASS =
  "motion-hover inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";
export const BUTTON_OUTLINE_CLASS = `${BUTTON_BASE_CLASS} border-[var(--console-border-strong)] bg-[var(--console-surface)] text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]`;
export const BUTTON_PRIMARY_CLASS = `${BUTTON_BASE_CLASS} border-transparent bg-[var(--brand)] text-[var(--brand-fg)] hover:bg-[var(--brand-hover)]`;
export const BUTTON_GHOST_CLASS = `${BUTTON_BASE_CLASS} border-transparent text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]`;

export const FIELD_LABEL_CLASS =
  "flex flex-col gap-1.5 text-xs font-medium text-[var(--console-text)]";
export const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 text-[13px] font-normal text-[var(--console-text)] outline-none focus:border-[var(--brand)] focus:ring-3 focus:ring-[var(--brand)]/15";
