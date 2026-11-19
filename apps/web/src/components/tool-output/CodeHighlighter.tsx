import { useLocale } from "../../hooks/useLocale";
import { lazy, Suspense, useMemo } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { CODE_METRICS } from "./code-metrics";
import { ProgressiveText } from "../ProgressiveContent";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";
import { buildHighlightPattern, matchesHighlightPattern } from "../../lib/search-highlight";
import { renderHighlightedText } from "../HighlightedText";

export interface CodeHighlighterProps {
  language: string;
  text: string;
  highlightQuery?: string;
}

// Prism and its language grammars are the largest thing a session detail pulls
// in, and plenty of sessions never show a code block — so it loads on the first
// one, behind a fallback that already shows the code.
const PrismHighlighter = lazy(() =>
  import("./PrismHighlighter").then((m) => ({ default: m.PrismHighlighter })),
);

function PlainCode({ text, highlightQuery }: { text: string; highlightQuery?: string }) {
  useLocale();

  return (
    <pre
      className="console-mono m-0 overflow-x-auto whitespace-pre-wrap break-words p-3 text-[var(--code-fg)]"
      style={{ background: "transparent", ...CODE_METRICS }}
    >
      {renderHighlightedText(text, highlightQuery)}
    </pre>
  );
}

export function CodeHighlighter({ language, text, highlightQuery }: CodeHighlighterProps) {
  useLocale();
  const highlightPattern = useMemo(() => buildHighlightPattern(highlightQuery), [highlightQuery]);

  return (
    <ProgressiveText
      text={text}
      initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.code}
      highlightQuery={highlightQuery}
    >
      {(visibleText) =>
        matchesHighlightPattern(visibleText, highlightPattern) ? (
          // Use plain highlighted text when matches exist so multi-token queries
          // are not broken across Prism span boundaries.
          <PlainCode text={visibleText} highlightQuery={highlightQuery} />
        ) : (
          <ErrorBoundary fallback={<PlainCode text={visibleText} />}>
            <Suspense fallback={<PlainCode text={visibleText} />}>
              <PrismHighlighter language={language} text={visibleText} />
            </Suspense>
          </ErrorBoundary>
        )
      }
    </ProgressiveText>
  );
}
