import type { PropertyItem } from "./types";

function displayScalar(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function PropertyValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const scalar = displayScalar(value);
  if (scalar != null) {
    return <span className="whitespace-pre-wrap break-words">{scalar}</span>;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) return <span>{value.length} items</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, index) => (
          <span
            key={index}
            className="rounded-sm border border-[var(--console-border)] bg-white px-1.5 py-0.5"
          >
            <PropertyValue value={item} depth={depth + 1} />
          </span>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    if (depth >= 2) return <span>{Object.keys(value as object).length} fields</span>;
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
  return (
    <dl className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[#fafafa]">
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
