import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function EmptyState({
  icon,
  title,
  tone = "neutral",
  className,
  children,
  ...rest
}: Omit<ComponentProps<"div">, "title"> & {
  icon: ReactNode;
  title: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed px-4 py-8 text-center text-xs text-[var(--console-muted)]",
        tone === "error"
          ? "border-[var(--console-error-border)]"
          : "border-[var(--console-border-strong)]",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-10 items-center justify-center rounded-full",
          tone === "error"
            ? "bg-[var(--console-error-bg)] text-[var(--console-error)] shadow-[0_0_0_1px_var(--console-error-border)]"
            : "bg-[var(--console-surface)] shadow-[0_0_0_1px_var(--console-border)]",
        )}
      >
        {icon}
      </span>
      <h2 className="text-[13px] font-medium text-[var(--console-text)]">{title}</h2>
      {children}
    </div>
  );
}
