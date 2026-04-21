import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

const markdownComponents: Components = {
  a: ({ children }) => <span className="console-markdown-link">{children}</span>,
};

interface MarkdownContentProps {
  text: string;
  highlightQuery?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightPattern(query?: string): RegExp | null {
  const normalized = query?.trim();
  if (!normalized) return null;

  const terms = Array.from(
    new Set(
      (normalized.match(/"[^"]+"|\S+/g) ?? [])
        .map((term) => term.replace(/^"|"$/g, "").trim())
        .filter(Boolean)
        .filter((term) => !/^OR$/i.test(term)),
    ),
  );

  if (terms.length === 0) return null;
  return new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
}

export function MarkdownContent({ text, highlightQuery }: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const highlightPattern = useMemo(() => buildHighlightPattern(highlightQuery), [highlightQuery]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !highlightPattern) {
      return;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest("mark, pre, code")) continue;
      if (!node.textContent?.trim()) continue;
      textNodes.push(node);
    }

    for (const node of textNodes) {
      const source = node.textContent ?? "";
      highlightPattern.lastIndex = 0;
      if (!highlightPattern.test(source)) continue;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      highlightPattern.lastIndex = 0;

      for (const match of source.matchAll(highlightPattern)) {
        const start = match.index ?? 0;
        const matched = match[0] ?? "";
        if (start > lastIndex) {
          fragment.append(source.slice(lastIndex, start));
        }
        const mark = document.createElement("mark");
        mark.textContent = matched;
        fragment.append(mark);
        lastIndex = start + matched.length;
      }

      if (lastIndex < source.length) {
        fragment.append(source.slice(lastIndex));
      }

      node.parentNode?.replaceChild(fragment, node);
    }
  }, [highlightPattern, text]);

  return (
    <div ref={containerRef}>
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
    </div>
  );
}
