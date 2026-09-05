import { useLocale } from "../../hooks/useLocale";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { CODE_METRICS } from "./code-metrics";
import { ProgressiveText } from "../ProgressiveContent";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";

export interface CodeHighlighterProps {
  language: string;
  text: string;
}

// Prism and its language grammars are the largest thing a session detail pulls
// in, and plenty of sessions never show a code block — so it loads on the first
// one, behind a fallback that already shows the code.
const PrismHighlighter = lazy(() =>
  import("./PrismHighlighter").then((m) => ({ default: m.PrismHighlighter })),
);

function PlainCode({ text }: { text: string }) {
  useLocale();

  return (
    <pre
      className="console-mono m-0 overflow-x-auto whitespace-pre-wrap break-words p-3 text-[var(--code-fg)]"
      style={{ background: "transparent", ...CODE_METRICS }}
    >
      {text}
    </pre>
  );
}

export function CodeHighlighter({ language, text }: CodeHighlighterProps) {
  useLocale();

  return (
    <ProgressiveText text={text} initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.code}>
      {(visibleText) => (
        <ErrorBoundary fallback={<PlainCode text={visibleText} />}>
          <Suspense fallback={<PlainCode text={visibleText} />}>
            <PrismHighlighter language={language} text={visibleText} />
          </Suspense>
        </ErrorBoundary>
      )}
    </ProgressiveText>
  );
}
