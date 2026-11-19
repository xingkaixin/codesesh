import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { CodeHighlighter } from "./CodeHighlighter";
import type { FileSectionItem } from "./types";
import { UnifiedDiffOutput } from "./UnifiedDiffOutput";
import { ProgressiveText } from "../ProgressiveContent";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";
import { renderHighlightedText } from "../HighlightedText";

interface FileSectionsOutputProps {
  sections: FileSectionItem[];
  highlightQuery?: string;
}

function renderSectionContent(section: FileSectionItem, highlightQuery?: string) {
  const hasText = Boolean(section.text);
  const outputText = section.text || t("No output captured.");
  const activeHighlight = hasText ? highlightQuery : undefined;

  if (!section.isCode || section.language === "text") {
    return (
      <ProgressiveText text={outputText} initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}>
        {(visibleText) => (
          <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed text-[var(--console-text)]">
            {renderHighlightedText(visibleText, activeHighlight)}
          </pre>
        )}
      </ProgressiveText>
    );
  }

  if (section.language === "diff") {
    return <UnifiedDiffOutput text={outputText} highlightQuery={activeHighlight} />;
  }

  return (
    <div className="max-h-[420px] overflow-auto bg-[var(--console-surface-sunken)]">
      <CodeHighlighter
        language={section.language}
        text={outputText}
        highlightQuery={activeHighlight}
      />
    </div>
  );
}

export function FileSectionsOutput({ sections, highlightQuery }: FileSectionsOutputProps) {
  useLocale();

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div
          key={`${section.operation}:${section.label}:${section.language}`}
          className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]"
        >
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--console-muted)]">
                {section.operation}
              </span>
              <span className="console-mono text-[11px] font-semibold text-[var(--console-muted)]">
                {renderHighlightedText(section.label, highlightQuery)}
              </span>
            </div>
          </div>
          {renderSectionContent(section, highlightQuery)}
        </div>
      ))}
    </div>
  );
}
