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
      className={`rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-4 text-[var(--console-error)] ${className}`}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="console-mono mt-1 break-words text-[11px]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="console-mono mt-3 rounded-sm border border-[var(--console-error-border)] bg-[var(--console-surface)] px-2.5 py-1 text-[11px] font-semibold motion-hover hover:bg-[var(--console-error-bg)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Retry")}
      </button>
    </div>
  );
}
