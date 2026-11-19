import { buildHighlightPattern } from "../lib/search-highlight";
import { formatNumber } from "../lib/format";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  useLocale();

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="console-mono mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2.5 py-2 text-[11px] text-[var(--console-muted)]">
      <span>
        {t("Showing {0} of {1}", [formatNumber(rendered), formatNumber(total)])} {t(unit)}
      </span>
      <button
        type="button"
        onClick={onRenderMore}
        aria-label={t("Render more content")}
        className="motion-hover motion-press rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 font-semibold text-[var(--console-text)] hover:border-[var(--console-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      >
        {t("Render more")}
      </button>
      <button
        type="button"
        onClick={() => {
          const text = typeof copySource === "function" ? copySource() : copySource;
          void writeToClipboard(text).then((ok) => {
            if (ok) setCopied(true);
          });
        }}
        aria-label={copied ? t("Full content copied") : t("Copy full content")}
        className="motion-hover motion-press inline-flex items-center gap-1 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 font-semibold text-[var(--console-text)] hover:border-[var(--console-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? t("Copied") : t("Copy full")}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? t("Full content copied") : ""}
      </span>
    </div>
  );
}

interface ProgressiveTextProps {
  text: string;
  initialBudget: ContentRenderBudget;
  highlightQuery?: string;
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

function previewMatchPosition(root: HTMLDivElement | null) {
  const mark = root?.querySelector("mark");
  if (!root || !mark) return;
  // The transcript owns its own search jump. Scroll only the bounded output pane.
  for (
    let pane = mark.parentElement;
    pane && pane !== root.parentElement?.parentElement;
    pane = pane.parentElement
  ) {
    if (
      pane.scrollHeight > pane.clientHeight &&
      /^(auto|scroll)$/.test(getComputedStyle(pane).overflowY)
    ) {
      const rect = mark.getBoundingClientRect();
      return { pane, offset: rect.top - pane.getBoundingClientRect().top, height: rect.height };
    }
  }
}

export function ProgressiveText({
  text,
  initialBudget,
  highlightQuery,
  children,
}: ProgressiveTextProps) {
  useLocale();

  const { budget, renderMore } = useProgressiveRenderBudget(text, initialBudget, {
    characters: text.length,
    lines: text.length + 1,
  });
  const match = useMemo(
    () => buildHighlightPattern(highlightQuery)?.exec(text),
    [text, highlightQuery],
  );
  const preview = useMemo(() => {
    const prefix = buildTextRenderPreview(text, budget);
    if (!match || !prefix.truncated || match.index + match[0].length <= prefix.renderedCharacters)
      return prefix;
    const earliest = Math.max(0, match.index - Math.floor(budget.maxCharacters / 2));
    let start = match.index;
    let lines = 0;
    while (start > earliest) {
      if (text.charAt(start - 1) === "\n" && ++lines >= Math.ceil(budget.maxLines / 2)) break;
      start--;
    }
    if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
    const excerpt = buildTextRenderPreview(text.slice(start), budget);
    return {
      ...excerpt,
      text: (start > 0 ? "…" : "") + excerpt.text,
      truncated: start > 0 || excerpt.truncated,
    };
  }, [budget, text, match]);

  const previewRef = useRef<HTMLDivElement>(null);
  const readingOffset = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!match) return;
    const position = previewMatchPosition(previewRef.current);
    if (!position) return;
    const { pane, offset, height } = position;
    const previous = readingOffset.current;
    readingOffset.current = null;
    if (previous !== null) {
      pane.scrollBy({ top: offset - previous });
    } else if (offset < 0 || offset + height > pane.clientHeight) {
      pane.scrollBy({ top: offset - pane.clientHeight / 2 });
    }
  }, [match, budget]);

  return (
    <div ref={previewRef} className="contents">
      {children(preview.text)}
      {preview.truncated ? (
        <ContentRenderControls
          copySource={text}
          onRenderMore={() => {
            readingOffset.current = match
              ? (previewMatchPosition(previewRef.current)?.offset ?? null)
              : null;
            renderMore();
          }}
          rendered={preview.renderedCharacters}
          total={text.length}
          unit="characters"
        />
      ) : null}
    </div>
  );
}
