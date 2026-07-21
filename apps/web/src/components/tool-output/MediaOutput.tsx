import type { MediaItem } from "./types";

export function MediaOutput({ items, text }: { items: MediaItem[]; text?: string }) {
  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${items.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {items.map((item, index) => (
          <figure
            key={`${item.src.slice(0, 80)}:${index}`}
            className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]"
          >
            <img
              src={item.src}
              alt={item.alt}
              className="max-h-[520px] w-full object-contain"
              loading="lazy"
            />
            {item.caption ? (
              <figcaption className="console-mono border-t border-[var(--console-border)] px-3 py-2 text-[11px] text-[var(--console-muted)]">
                {item.caption}
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
      {text ? (
        <pre className="console-mono whitespace-pre-wrap break-words rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)] p-3 text-xs leading-relaxed text-[var(--console-text)]">
          {text}
        </pre>
      ) : null}
    </div>
  );
}
