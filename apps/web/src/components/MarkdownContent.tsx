import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, Options } from "react-markdown";

const markdownComponents: Components = {
  a: ({ children }) => <span className="console-markdown-link">{children}</span>,
};

interface MarkdownContentProps {
  text: string;
  highlightQuery?: string;
}

/** Minimal shape of the hast nodes this plugin walks. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose text is shown verbatim, so search must not rewrite it. */
const OPAQUE_TAG_NAMES = new Set(["code", "pre", "mark"]);

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

/** Splits a text node around matches, or returns null when nothing matched. */
function splitHighlighted(value: string, pattern: RegExp): HastNode[] | null {
  const nodes: HastNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matched = match[0] ?? "";
    if (!matched) continue;
    if (start > lastIndex) nodes.push({ type: "text", value: value.slice(lastIndex, start) });
    nodes.push({
      type: "element",
      tagName: "mark",
      properties: {},
      children: [{ type: "text", value: matched }],
    });
    lastIndex = start + matched.length;
  }

  if (nodes.length === 0) return null;
  if (lastIndex < value.length) nodes.push({ type: "text", value: value.slice(lastIndex) });
  return nodes;
}

function highlightChildren(node: HastNode, pattern: RegExp): void {
  if (!node.children) return;

  const next: HastNode[] = [];
  let changed = false;

  for (const child of node.children) {
    if (child.type === "text") {
      const split = splitHighlighted(child.value ?? "", pattern);
      if (split) {
        next.push(...split);
        changed = true;
        continue;
      }
    } else if (!(child.tagName && OPAQUE_TAG_NAMES.has(child.tagName))) {
      highlightChildren(child, pattern);
    }
    next.push(child);
  }

  if (changed) node.children = next;
}

/**
 * Emits `<mark>` as part of the rendered tree. Rewriting the DOM after React
 * renders would leave stale highlights behind whenever the query changed, since
 * React would keep reusing the nodes it still believes are plain text.
 */
function rehypeHighlightTerms(pattern: RegExp) {
  return (tree: HastNode) => highlightChildren(tree, pattern);
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
  highlightQuery,
}: MarkdownContentProps) {
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(() => {
    const pattern = buildHighlightPattern(highlightQuery);
    return pattern ? [[rehypeHighlightTerms, pattern]] : undefined;
  }, [highlightQuery]);

  return (
    <div>
      <ReactMarkdown components={markdownComponents} rehypePlugins={rehypePlugins}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
