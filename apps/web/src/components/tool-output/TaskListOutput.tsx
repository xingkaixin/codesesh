import { Check, Circle, CircleDashed, X } from "lucide-react";
import type { TaskListItem } from "./types";

const STATUS_META = {
  completed: { Icon: Check, label: "Done", className: "text-[var(--console-success)]" },
  error: { Icon: X, label: "Failed", className: "text-[var(--console-error)]" },
  in_progress: {
    Icon: CircleDashed,
    label: "In progress",
    className: "text-[var(--console-warning)]",
  },
  pending: { Icon: Circle, label: "Pending", className: "text-[var(--console-muted)]" },
} as const;

export function TaskListOutput({ items }: { items: TaskListItem[] }) {
  return (
    <ol className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white">
      {items.map((item, index) => {
        const meta = STATUS_META[item.status];
        return (
          <li
            key={`${item.label}:${index}`}
            className="flex gap-3 border-b border-[var(--console-border)] px-3 py-2.5 last:border-b-0"
          >
            <meta.Icon className={`mt-0.5 size-3.5 shrink-0 ${meta.className}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-xs font-medium leading-relaxed text-[var(--console-text)]">
                  {item.label}
                </span>
                <span
                  className={`console-mono text-[10px] uppercase tracking-wide ${meta.className}`}
                >
                  {meta.label}
                </span>
              </div>
              {item.detail ? (
                <p className="mt-1 text-xs leading-relaxed text-[var(--console-muted)]">
                  {item.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
