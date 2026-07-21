import type { DiffBlock, DiffLineItem } from "./types";

interface StructuredDiffOutputProps {
  blocks: DiffBlock[];
}

function getBlockKey(block: DiffBlock) {
  return `${block.label}:${block.lines.map((l) => `${l.type}:${l.text}`).join("\n")}`;
}

function getStructuredDiffLineClassName(type: DiffLineItem["type"]) {
  if (type === "add") {
    return "text-[#15803d] bg-[#f0fdf4] dark:text-[var(--console-success)] dark:bg-[var(--console-success-bg)]";
  }
  if (type === "remove") {
    return "text-[#b91c1c] bg-[#fef2f2] dark:text-[var(--console-error)] dark:bg-[var(--console-error-bg)]";
  }
  return "text-[var(--console-text)]";
}

export function StructuredDiffOutput({ blocks }: StructuredDiffOutputProps) {
  return (
    <div className="space-y-3">
      {blocks.map((block) => {
        const lineOccurrences = new Map<string, number>();
        return (
          <div
            key={getBlockKey(block)}
            className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]"
          >
            <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
              <span className="console-mono text-[11px] font-semibold text-[var(--console-muted)]">
                {block.label}
              </span>
            </div>
            <pre className="console-mono max-h-[280px] overflow-auto whitespace-pre p-3 text-xs leading-relaxed">
              {block.lines.map((line) => {
                const key = `${line.type}:${line.text}`;
                const occ = lineOccurrences.get(key) ?? 0;
                lineOccurrences.set(key, occ + 1);
                return (
                  <span
                    key={`${key}:${occ}`}
                    className={`block rounded-[2px] px-1 ${getStructuredDiffLineClassName(line.type)}`}
                  >
                    {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                    {line.text || " "}
                  </span>
                );
              })}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
