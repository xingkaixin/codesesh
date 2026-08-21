import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "./ui/icons";
import { writeToClipboard } from "../lib/clipboard";
import {
  buildTextRenderPreview,
  growContentRenderBudget,
  type ContentRenderBudget,
} from "../lib/content-render-budget";

type CopySource = string | (() => string);

interface ContentRenderControlsProps {
  copySource: CopySource;
  onRenderMore: () => void;
  rendered: number;
  total: number;
  unit: "characters" | "lines";
}

export function ContentRenderControls({
  copySource,
  onRenderMore,
  rendered,
  total,
  unit,
}: ContentRenderControlsProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="console-mono mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2.5 py-2 text-[11px] text-[var(--console-muted)]">
      <span>
        Showing {rendered.toLocaleString()} of {total.toLocaleString()} {unit}
      </span>
      <button
        type="button"
        onClick={onRenderMore}
        aria-label="Render more content"
        className="motion-hover motion-press rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 font-semibold text-[var(--console-text)] hover:border-[var(--console-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      >
        Render more
      </button>
      <button
        type="button"
        onClick={() => {
          const text = typeof copySource === "function" ? copySource() : copySource;
          void writeToClipboard(text).then((ok) => {
            if (ok) setCopied(true);
          });
        }}
        aria-label={copied ? "Full content copied" : "Copy full content"}
        className="motion-hover motion-press inline-flex items-center gap-1 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 font-semibold text-[var(--console-text)] hover:border-[var(--console-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy full"}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Full content copied" : ""}
      </span>
    </div>
  );
}

interface ProgressiveTextProps {
  text: string;
  initialBudget: ContentRenderBudget;
  children: (visibleText: string) => ReactNode;
}

interface ProgressiveRenderTotals {
  characters?: number;
  lines?: number;
}

export function useProgressiveRenderBudget(
  source: unknown,
  initialBudget: ContentRenderBudget,
  totals: ProgressiveRenderTotals,
) {
  const [expanded, setExpanded] = useState<{
    source: unknown;
    budget: ContentRenderBudget;
  } | null>(null);
  const budget = expanded && Object.is(expanded.source, source) ? expanded.budget : initialBudget;

  return {
    budget,
    renderMore: () =>
      setExpanded({
        source,
        budget: growContentRenderBudget(
          budget,
          totals.characters ?? Number.MAX_SAFE_INTEGER,
          totals.lines ?? Number.MAX_SAFE_INTEGER,
        ),
      }),
  };
}

export function ProgressiveText({ text, initialBudget, children }: ProgressiveTextProps) {
  const { budget, renderMore } = useProgressiveRenderBudget(text, initialBudget, {
    characters: text.length,
    lines: text.length + 1,
  });
  const preview = useMemo(() => buildTextRenderPreview(text, budget), [budget, text]);

  return (
    <>
      {children(preview.text)}
      {preview.truncated ? (
        <ContentRenderControls
          copySource={text}
          onRenderMore={renderMore}
          rendered={preview.renderedCharacters}
          total={text.length}
          unit="characters"
        />
      ) : null}
    </>
  );
}
