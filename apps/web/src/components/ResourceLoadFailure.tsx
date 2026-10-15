import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";

export function ResourceLoadFailure({
  title,
  message,
  onRetry,
  className = "",
}: {
  title: string;
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  useLocale();

  return (
    <div
      role="alert"
      className={`rounded-[10px] bg-[var(--console-error-bg)] px-3 py-2.5 text-[var(--console-error)] shadow-[inset_0_0_0_1px_var(--console-error-border)] ${className}`}
    >
      <p className="text-xs font-medium">{title}</p>
      <p className="console-mono mt-1 break-words text-[11px]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex h-6 items-center rounded-md border border-[var(--console-error-border)] bg-[var(--console-surface)] px-2 text-[11px] font-medium motion-hover hover:bg-[var(--console-error-bg)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Retry")}
      </button>
    </div>
  );
}
