import { lazy, Suspense } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { CODE_METRICS } from "../../styles/prism-theme";

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
  return (
    <ErrorBoundary fallback={<PlainCode text={text} />}>
      <Suspense fallback={<PlainCode text={text} />}>
        <PrismHighlighter language={language} text={text} />
      </Suspense>
    </ErrorBoundary>
  );
}
