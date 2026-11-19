import type { ReactNode } from "react";
import { buildHighlightPattern } from "../lib/search-highlight";

export function renderHighlightedText(text: string, query?: string): ReactNode {
  const pattern = buildHighlightPattern(query);
  if (!pattern || !text) return text;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matched = match[0] ?? "";
    if (!matched) continue;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(<mark key={`${start}-${matched.length}`}>{matched}</mark>);
    lastIndex = start + matched.length;
  }

  if (nodes.length === 0) return text;
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
