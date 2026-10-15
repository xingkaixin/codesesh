import { CheckCircle2 } from "../ui/icons";

/** Transient confirmations (copy, live refresh) stacked in the bottom-right corner. */
export function AppToasts({ messages }: { messages: (string | null)[] }) {
  const visible = messages.filter((message): message is string => Boolean(message));
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(400px,calc(100vw-32px))] flex-col gap-2.5"
    >
      {visible.map((message) => (
        <div
          key={message}
          role="status"
          className="motion-menu flex items-center gap-3 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] px-3.5 py-3 shadow-[var(--shadow-overlay)]"
        >
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--console-success-bg)] text-[var(--console-success)]">
            <CheckCircle2 aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-[13px] font-semibold text-[var(--console-text)]">
            {message}
          </span>
        </div>
      ))}
    </div>
  );
}
