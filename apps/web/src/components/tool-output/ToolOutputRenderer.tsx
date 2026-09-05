import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { CodeHighlighter } from "./CodeHighlighter";
import { FileSectionsOutput } from "./FileSectionsOutput";
import { MediaOutput } from "./MediaOutput";
import { PropertyListOutput } from "./PropertyListOutput";
import { QuestionListOutput } from "./QuestionListOutput";
import { StructuredDiffOutput } from "./StructuredDiffOutput";
import { TaskListOutput } from "./TaskListOutput";
import type { ToolOutputContent } from "./types";
import { UnifiedDiffOutput } from "./UnifiedDiffOutput";
import { ProgressiveText } from "../ProgressiveContent";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";

interface ToolOutputRendererProps {
  outputContent: ToolOutputContent;
}

export function ToolOutputRenderer({ outputContent }: ToolOutputRendererProps) {
  useLocale();

  if (outputContent.kind === "structured-diff") {
    return <StructuredDiffOutput blocks={outputContent.blocks} />;
  }

  if (outputContent.kind === "file-sections") {
    return <FileSectionsOutput sections={outputContent.sections} />;
  }

  if (outputContent.kind === "question-list") {
    return <QuestionListOutput questions={outputContent.questions} />;
  }

  if (outputContent.kind === "task-list") {
    return <TaskListOutput items={outputContent.items} />;
  }

  if (outputContent.kind === "media") {
    return <MediaOutput items={outputContent.items} text={outputContent.text} />;
  }

  if (outputContent.kind === "property-list") {
    return <PropertyListOutput items={outputContent.items} />;
  }

  const outputText = outputContent.text || t("No output captured.");

  if (!outputContent.isCode || outputContent.language === "text") {
    return (
      <ProgressiveText text={outputText} initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}>
        {(visibleText) => (
          <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)] p-3 text-xs leading-relaxed text-[var(--console-text)]">
            {visibleText}
          </pre>
        )}
      </ProgressiveText>
    );
  }

  if (outputContent.language === "diff") {
    return <UnifiedDiffOutput text={outputText} />;
  }

  return (
    <div className="max-h-[420px] overflow-auto rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]">
      <CodeHighlighter language={outputContent.language} text={outputText} />
    </div>
  );
}
