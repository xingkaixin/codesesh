import { useState, type ReactNode } from "react";
import { t } from "../../i18n/translate";
import { CopyButton } from "../nodes/CopyButton";
import { CodeHighlighter } from "./CodeHighlighter";
import type { CodeExecutionToolOutputContent } from "./types";

export function CodeExecutionOutput({
  content,
  children,
}: {
  content: CodeExecutionToolOutputContent;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(content.failed);
  return (
    <div className="min-w-0 space-y-3">
      {children}
      {content.source ? (
        <details
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
          className="min-w-0 border-t border-[var(--console-border)] pt-1"
        >
          <summary className="cursor-pointer rounded-sm py-2 text-xs font-semibold text-[var(--console-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
            {t("Source code")} · {content.language === "javascript" ? "JavaScript" : "TypeScript"}
          </summary>
          {open ? (
            <div className="space-y-2">
              <div className="flex justify-end">
                <CopyButton value={content.source} label={t("Copy source")} />
              </div>
              <div className="max-h-[420px] overflow-auto rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]">
                <CodeHighlighter language={content.language} text={content.source} />
              </div>
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
