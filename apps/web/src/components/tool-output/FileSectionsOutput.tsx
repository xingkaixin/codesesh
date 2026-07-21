import { CodeHighlighter } from "./CodeHighlighter";
import type { FileSectionItem } from "./types";
import { UnifiedDiffOutput } from "./UnifiedDiffOutput";

interface FileSectionsOutputProps {
  sections: FileSectionItem[];
}

function renderSectionContent(section: FileSectionItem) {
  const outputText = section.text || "No output captured.";

  if (!section.isCode || section.language === "text") {
    return (
      <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed text-[var(--console-text)]">
        {outputText}
      </pre>
    );
  }

  if (section.language === "diff") {
    return <UnifiedDiffOutput text={outputText} />;
  }

  return (
    <div className="max-h-[420px] overflow-auto bg-[var(--console-surface-sunken)]">
      <CodeHighlighter language={section.language} text={outputText} />
    </div>
  );
}

export function FileSectionsOutput({ sections }: FileSectionsOutputProps) {
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
                {section.label}
              </span>
            </div>
          </div>
          {renderSectionContent(section)}
        </div>
      ))}
    </div>
  );
}
