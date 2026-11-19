import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { CodeHighlighter } from "./CodeHighlighter";
import { CodeExecutionOutput } from "./CodeExecutionOutput";
import { FileSectionsOutput } from "./FileSectionsOutput";
import { MediaOutput } from "./MediaOutput";
import { PropertyListOutput } from "./PropertyListOutput";
import { QuestionListOutput } from "./QuestionListOutput";
import { StructuredDiffOutput } from "./StructuredDiffOutput";
import { TaskListOutput } from "./TaskListOutput";
import { ThreadReadOutput } from "./ThreadReadOutput";
import type { ToolOutputContent } from "./types";
import { UnifiedDiffOutput } from "./UnifiedDiffOutput";
import { ProgressiveText } from "../ProgressiveContent";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";
import { renderHighlightedText } from "../HighlightedText";

interface ToolOutputRendererProps {
  outputContent: ToolOutputContent;
  highlightQuery?: string;
}

export function ToolOutputRenderer({ outputContent, highlightQuery }: ToolOutputRendererProps) {
  useLocale();

  if (outputContent.kind === "code-execution") {
    return (
      <CodeExecutionOutput content={outputContent} highlightQuery={highlightQuery}>
        {outputContent.output.map((block, index) => (
          <ToolOutputRenderer key={index} outputContent={block} highlightQuery={highlightQuery} />
        ))}
      </CodeExecutionOutput>
    );
  }

  if (outputContent.kind === "thread-read") {
    return <ThreadReadOutput content={outputContent} highlightQuery={highlightQuery} />;
  }

  if (outputContent.kind === "structured-diff") {
    return <StructuredDiffOutput blocks={outputContent.blocks} highlightQuery={highlightQuery} />;
  }

  if (outputContent.kind === "file-sections") {
    return <FileSectionsOutput sections={outputContent.sections} highlightQuery={highlightQuery} />;
  }

  if (outputContent.kind === "question-list") {
    return (
      <QuestionListOutput questions={outputContent.questions} highlightQuery={highlightQuery} />
    );
  }

  if (outputContent.kind === "task-list") {
    return <TaskListOutput items={outputContent.items} highlightQuery={highlightQuery} />;
  }

  if (outputContent.kind === "media") {
    return (
      <MediaOutput
        items={outputContent.items}
        text={outputContent.text}
        highlightQuery={highlightQuery}
      />
    );
  }

  if (outputContent.kind === "property-list") {
    return <PropertyListOutput items={outputContent.items} highlightQuery={highlightQuery} />;
  }

  const hasCapturedOutput = Boolean(outputContent.text);
  const outputText = outputContent.text || t("No output captured.");
  const activeHighlight = hasCapturedOutput ? highlightQuery : undefined;

  if (!outputContent.isCode || outputContent.language === "text") {
    return (
      <ProgressiveText
        text={outputText}
        initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}
        highlightQuery={activeHighlight}
      >
        {(visibleText) => (
          <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)] p-3 text-xs leading-relaxed text-[var(--console-text)]">
            {renderHighlightedText(visibleText, activeHighlight)}
          </pre>
        )}
      </ProgressiveText>
    );
  }

  if (outputContent.language === "diff") {
    return <UnifiedDiffOutput text={outputText} highlightQuery={activeHighlight} />;
  }

  return (
    <div className="max-h-[420px] overflow-auto rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]">
      <CodeHighlighter
        language={outputContent.language}
        text={outputText}
        highlightQuery={activeHighlight}
      />
    </div>
  );
}
