import { CodeHighlighter } from "./CodeHighlighter";
import { FileSectionsOutput } from "./FileSectionsOutput";
import { MediaOutput } from "./MediaOutput";
import { PropertyListOutput } from "./PropertyListOutput";
import { QuestionListOutput } from "./QuestionListOutput";
import { StructuredDiffOutput } from "./StructuredDiffOutput";
import { TaskListOutput } from "./TaskListOutput";
import type { ToolOutputContent } from "./types";
import { UnifiedDiffOutput } from "./UnifiedDiffOutput";

interface ToolOutputRendererProps {
  outputContent: ToolOutputContent;
}

export function ToolOutputRenderer({ outputContent }: ToolOutputRendererProps) {
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

  const outputText = outputContent.text || "No output captured.";

  if (!outputContent.isCode || outputContent.language === "text") {
    return (
      <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-[var(--console-border)] bg-[#fafafa] p-3 text-xs leading-relaxed text-[var(--console-text)]">
        {outputText}
      </pre>
    );
  }

  if (outputContent.language === "diff") {
    return <UnifiedDiffOutput text={outputText} />;
  }

  return (
    <div className="max-h-[420px] overflow-auto rounded-sm border border-[var(--console-border)] bg-[#fafafa]">
      <CodeHighlighter language={outputContent.language} text={outputText} />
    </div>
  );
}
