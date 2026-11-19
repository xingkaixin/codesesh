import { useState, type ReactNode } from "react";
import { t } from "../../i18n/translate";
import { buildHighlightPattern, matchesHighlightPattern } from "../../lib/search-highlight";
import { CopyButton } from "../nodes/CopyButton";
import { CodeHighlighter } from "./CodeHighlighter";
import type { CodeExecutionToolOutputContent } from "./types";

export function CodeExecutionOutput({
  content,
  highlightQuery,
  children,
}: {
  content: CodeExecutionToolOutputContent;
  highlightQuery?: string;
  children: ReactNode;
}) {
  const sourceMatches = Boolean(
    content.source &&
    matchesHighlightPattern(content.source, buildHighlightPattern(highlightQuery)),
  );
  const [open, setOpen] = useState(content.failed || sourceMatches);
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
                <CodeHighlighter
                  language={content.language}
                  text={content.source}
                  highlightQuery={highlightQuery}
                />
              </div>
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
