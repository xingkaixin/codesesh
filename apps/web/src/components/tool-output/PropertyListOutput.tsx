import { useState, type ReactNode } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";
import { ProgressiveText } from "../ProgressiveContent";
import { toDisplayText } from "../session-detail/tool-normalize";
import type { PropertyItem } from "./types";

function displayScalar(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function NestedJson({ value, children }: { value: unknown; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0"
    >
      <summary className="cursor-pointer rounded-sm text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
        {children}
      </summary>
      {open ? (
        <ProgressiveText
          text={toDisplayText(value)}
          initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}
        >
          {(text) => (
            <pre className="console-mono mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words">
              {text}
            </pre>
          )}
        </ProgressiveText>
      ) : null}
    </details>
  );
}

function PropertyValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  useLocale();

  const scalar = displayScalar(value);
  if (scalar != null) {
    return <span className="whitespace-pre-wrap break-words">{scalar}</span>;
  }

  if (Array.isArray(value)) {
    if (depth >= 2)
      return (
        <NestedJson value={value}>
          {value.length} {t("items")}
        </NestedJson>
      );
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, index) => (
          <span
            key={index}
            className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-0.5"
          >
            <PropertyValue value={item} depth={depth + 1} />
          </span>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    if (depth >= 2)
      return (
        <NestedJson value={value}>
          {Object.keys(value as object).length} {t("fields")}
        </NestedJson>
      );
    return (
      <dl className="space-y-1.5">
        {Object.entries(value as Record<string, unknown>).map(([key, nested]) => (
          <div key={key} className="grid grid-cols-[minmax(80px,auto)_1fr] gap-2">
            <dt className="text-[var(--console-muted)]">{key}</dt>
            <dd className="min-w-0">
              <PropertyValue value={nested} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span>{String(value)}</span>;
}

export function PropertyListOutput({ items }: { items: PropertyItem[] }) {
  useLocale();

  return (
    <dl className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]">
      {items.map((item) => (
        <div
          key={item.label}
          className="grid gap-1 border-b border-[var(--console-border)] px-3 py-2.5 last:border-b-0 sm:grid-cols-[130px_1fr] sm:gap-3"
        >
          <dt className="console-mono text-[10px] font-semibold uppercase tracking-wide text-[var(--console-muted)]">
            {item.label}
          </dt>
          <dd className="console-mono min-w-0 text-xs leading-relaxed text-[var(--console-text)]">
            <PropertyValue value={item.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
