import type { QuestionListItem } from "./types";

interface QuestionListOutputProps {
  questions: QuestionListItem[];
}

export function QuestionListOutput({ questions }: QuestionListOutputProps) {
  return (
    <div className="space-y-3">
      {questions.map((question) => (
        <div
          key={`${question.header ?? "question"}:${question.question}`}
          className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]"
        >
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {question.header ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--console-muted)]">
                  {question.header}
                </span>
              ) : null}
              {question.answers.length > 0 ? (
                <span className="console-mono text-[11px] font-semibold text-[var(--console-success)]">
                  Answered
                </span>
              ) : (
                <span className="console-mono text-[11px] font-semibold text-[var(--console-muted)]">
                  Pending
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-[var(--console-text)]">
              {question.question}
            </p>
          </div>
          <div className="space-y-2 p-3">
            {question.options.map((option) => {
              const isSelected = question.answers.includes(option.label);
              return (
                <div
                  key={`${question.question}:${option.label}`}
                  className={`rounded-sm border px-3 py-2 ${
                    isSelected
                      ? "border-[var(--console-success-border)] bg-[var(--console-success-bg)]"
                      : "border-[var(--console-border)] bg-[var(--console-surface)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`console-mono text-xs font-semibold ${
                        isSelected ? "text-[var(--console-success)]" : "text-[var(--console-text)]"
                      }`}
                    >
                      {option.label}
                    </span>
                    {option.recommended ? (
                      <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                        Recommended
                      </span>
                    ) : null}
                    {isSelected ? (
                      <span className="console-mono rounded-sm border border-[var(--console-success-border)] bg-[var(--console-surface)] px-1.5 py-0.5 text-[10px] text-[var(--console-success)]">
                        Selected
                      </span>
                    ) : null}
                  </div>
                  {option.description ? (
                    <p className="mt-1 text-xs leading-relaxed text-[var(--console-muted)]">
                      {option.description}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
