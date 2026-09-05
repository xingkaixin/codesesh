import { useLocale } from "../../hooks/useLocale";
import { useMemo } from "react";
import { diffToneClass } from "./diff-tone";
import type { DiffBlock } from "./types";
import { ContentRenderControls, useProgressiveRenderBudget } from "../ProgressiveContent";
import {
  INITIAL_CONTENT_RENDER_BUDGETS,
  type ContentRenderBudget,
} from "../../lib/content-render-budget";

interface StructuredDiffOutputProps {
  blocks: DiffBlock[];
}

interface StructuredDiffPreview {
  blocks: DiffBlock[];
  renderedLines: number;
  truncated: boolean;
}

function getStructuredDiffLineCount(blocks: DiffBlock[]) {
  let lines = 0;
  for (const block of blocks) {
    lines += block.lines.length + 1;
  }
  return lines;
}

function buildStructuredDiffPreview(
  blocks: DiffBlock[],
  budget: ContentRenderBudget,
): StructuredDiffPreview {
  const visibleBlocks: DiffBlock[] = [];
  let renderedCharacters = 0;
  let renderedLines = 0;
  let truncated = false;

  for (const block of blocks) {
    if (renderedLines >= budget.maxLines || renderedCharacters >= budget.maxCharacters) {
      truncated = true;
      break;
    }

    const remainingLabelCharacters = budget.maxCharacters - renderedCharacters;
    const label = block.label.slice(0, remainingLabelCharacters);
    renderedCharacters += label.length;
    renderedLines += 1;
    const lines: DiffBlock["lines"] = [];

    for (const line of block.lines) {
      if (renderedLines >= budget.maxLines || renderedCharacters >= budget.maxCharacters) {
        truncated = true;
        break;
      }
      const remainingTextCharacters = budget.maxCharacters - renderedCharacters - 1;
      if (remainingTextCharacters < 0) {
        truncated = true;
        break;
      }
      const text = line.text.slice(0, remainingTextCharacters);
      lines.push(text === line.text ? line : { ...line, text });
      renderedCharacters += text.length + 1;
      renderedLines += 1;
      if (text !== line.text) {
        truncated = true;
        break;
      }
    }

    visibleBlocks.push({ ...block, label, lines });
    if (label !== block.label || lines.length !== block.lines.length) {
      truncated = true;
      break;
    }
  }

  return { blocks: visibleBlocks, renderedLines, truncated };
}

function serializeStructuredDiff(blocks: DiffBlock[]) {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(`diff ${block.label}`);
    for (const line of block.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      lines.push(`${prefix}${line.text}`);
    }
  }
  return lines.join("\n");
}

export function StructuredDiffOutput({ blocks }: StructuredDiffOutputProps) {
  const locale = useLocale();

  const totalLines = useMemo(
    () => getStructuredDiffLineCount(blocks),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, blocks],
  );
  const { budget, renderMore } = useProgressiveRenderBudget(
    blocks,
    INITIAL_CONTENT_RENDER_BUDGETS.diff,
    { lines: totalLines },
  );
  const preview = useMemo(() => buildStructuredDiffPreview(blocks, budget), [blocks, budget]);

  return (
    <>
      <div className="space-y-3">
        {preview.blocks.map((block, blockIndex) => {
          return (
            <div
              key={`${block.label.slice(0, 80)}:${blockIndex}`}
              className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)]"
            >
              <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
                <span className="console-mono text-[11px] font-semibold text-[var(--console-muted)]">
                  {block.label}
                </span>
              </div>
              <pre className="console-mono max-h-[280px] overflow-auto whitespace-pre p-3 text-xs leading-relaxed">
                {block.lines.map((line, lineIndex) => {
                  return (
                    <span
                      key={`${line.type}:${lineIndex}`}
                      className={`block rounded-[2px] px-1 ${diffToneClass(line.type)}`}
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
      {preview.truncated ? (
        <ContentRenderControls
          copySource={() => serializeStructuredDiff(blocks)}
          onRenderMore={renderMore}
          rendered={preview.renderedLines}
          total={totalLines}
          unit="lines"
        />
      ) : null}
    </>
  );
}
