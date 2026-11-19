import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components, Options, UrlTransform } from "react-markdown";
import { writeToClipboard } from "../lib/clipboard";
import { resolveLocalMediaSource, resolveSafeExternalLink } from "../lib/local-media-policy";
import { buildHighlightPattern } from "../lib/search-highlight";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../lib/content-render-budget";
import { renderHighlightedText } from "./HighlightedText";
import { ProgressiveText } from "./ProgressiveContent";
import { CodeHighlighter } from "./tool-output/CodeHighlighter";
import { CODE_METRICS } from "./tool-output/code-metrics";
import { ArrowUpRight, Check, Copy } from "./ui/icons";

const remarkPlugins = [remarkGfm];
const PLAIN_CODE_LANGUAGES = new Set(["text", "plaintext", "txt"]);

interface MarkdownNode {
  type: string;
  position?: { end: { offset?: number } };
  children?: MarkdownNode[];
}

function omitIncompleteDefinition(lastLineStart: number) {
  return (tree: MarkdownNode) => {
    let parent = tree;
    while (parent.children) {
      const last = parent.children.at(-1);
      if (!last) break;
      if (last.type === "definition" && (last.position?.end.offset ?? 0) > lastLineStart) {
        parent.children.pop();
        return;
      }
      parent = last;
    }
  };
}

function extractTextContent(node: ReactNode): string | null {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) {
    let result = "";
    for (const part of node) {
      const text = extractTextContent(part);
      if (text === null) return null;
      result += text;
    }
    return result;
  }
  return null;
}

function extractFencedCode(children: ReactNode): { code: string; language?: string } | null {
  if (Children.count(children) !== 1) return null;
  const onlyChild = Children.only(children);
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) return null;
  const rawText = extractTextContent(onlyChild.props.children);
  if (rawText === null) return null;
  const match = /\blanguage-([^\s]+)/.exec(onlyChild.props.className ?? "");
  return {
    code: rawText.replace(/\n$/, ""),
    language: match?.[1],
  };
}

function MarkdownCodeBlock({
  code,
  complete,
  language,
  highlightQuery,
}: {
  code: string;
  complete: boolean;
  language?: string;
  highlightQuery?: string;
}) {
  useLocale();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const trimmedLanguage = language?.trim() || undefined;
  const useHighlighter =
    complete &&
    trimmedLanguage !== undefined &&
    !PLAIN_CODE_LANGUAGES.has(trimmedLanguage.toLowerCase());

  return (
    <div className="console-markdown-codeblock overflow-hidden rounded-md border border-[var(--console-border)] bg-[var(--console-surface-sunken)]">
      <div className="flex min-h-8 items-center justify-between gap-2 border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1">
        {trimmedLanguage ? (
          <span className="console-mono truncate text-[11px] font-medium text-[var(--console-muted)]">
            {trimmedLanguage}
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        {complete && (
          <button
            type="button"
            onClick={() => {
              void writeToClipboard(code).then((ok) => {
                if (ok) setCopied(true);
              });
            }}
            aria-label={copied ? t("Code copied") : t("Copy code")}
            title={copied ? t("Code copied") : t("Copy code")}
            className={`motion-hover motion-press inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
              copied
                ? "text-[var(--positive)]"
                : "text-[var(--console-muted)] hover:bg-[var(--console-surface)] hover:text-[var(--console-text)]"
            }`}
          >
            {copied ? (
              <Check className="size-3" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
            <span>{copied ? t("Copied") : t("Copy")}</span>
            <span className="sr-only" aria-live="polite">
              {copied ? t("Code copied") : ""}
            </span>
          </button>
        )}
      </div>
      <div className="console-scrollbar overflow-x-auto">
        {useHighlighter ? (
          <CodeHighlighter language={trimmedLanguage} text={code} highlightQuery={highlightQuery} />
        ) : (
          <pre
            className="console-mono m-0 overflow-x-auto whitespace-pre-wrap break-words p-3 text-[var(--code-fg)]"
            style={{ background: "transparent", ...CODE_METRICS }}
          >
            <code className="console-mono">{renderHighlightedText(code, highlightQuery)}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

const baseMarkdownComponents: Components = {
  table: ({ children }) => (
    <div
      className="console-scrollbar max-w-full overflow-x-auto rounded-sm border border-[var(--console-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      tabIndex={0}
      role="region"
      aria-label={t("Markdown table")}
    >
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt, title }) => {
    const safeSrc = resolveLocalMediaSource(typeof src === "string" ? src : undefined);
    if (!safeSrc) {
      return (
        <span className="console-mono inline-block rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
          {t("Remote image not loaded")}
          {alt ? `: ${alt}` : ""}
        </span>
      );
    }
    return (
      <img
        src={safeSrc}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        className="max-h-[520px] max-w-full rounded-md object-contain"
      />
    );
  },
};

function createMarkdownComponents(highlightQuery?: string, preview?: string): Components {
  const source = preview ?? "";
  const lastTokenStart =
    Math.max(...[" ", "\t", "\r", "\n"].map((char) => source.lastIndexOf(char))) + 1;
  let lastContentEnd = source.length;
  while (lastContentEnd > 0 && /[\s>]/u.test(source.charAt(lastContentEnd - 1))) {
    lastContentEnd -= 1;
  }
  return {
    ...baseMarkdownComponents,
    a: ({ href, children, node }) => {
      const safeHref = resolveSafeExternalLink(typeof href === "string" ? href : undefined);
      if (
        !safeHref ||
        (preview !== undefined && (node?.position?.end.offset ?? Infinity) > lastTokenStart)
      ) {
        return <span className="console-markdown-link">{children}</span>;
      }
      return (
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          title={safeHref}
          className="rounded-xs focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          {children}
          <ArrowUpRight
            aria-hidden="true"
            className="ml-0.5 inline size-3 align-baseline opacity-70"
          />
        </a>
      );
    },
    pre: ({ children, node }) => {
      const fenced = extractFencedCode(children);
      if (!fenced) return <pre>{children}</pre>;
      return (
        <MarkdownCodeBlock
          complete={
            preview === undefined || (node?.position?.end.offset ?? Infinity) < lastContentEnd
          }
          code={fenced.code}
          language={fenced.language}
          highlightQuery={highlightQuery}
        />
      );
    },
  };
}

const defaultMarkdownComponents = createMarkdownComponents();

/**
 * react-markdown's default transform drops inline image data and keeps remote
 * URLs — the opposite of what a local-only reader wants. Images stay restricted
 * to local/inline media, while links allow explicit http(s) targets for
 * user-initiated navigation.
 */
const transformMarkdownUrl: UrlTransform = (url, key) => {
  if (key === "href") {
    return resolveSafeExternalLink(url) ?? "";
  }
  return resolveLocalMediaSource(url) ?? "";
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

/**
 * Avoid nesting `<mark>` inside an existing highlight element, and leave `<pre>`
 * untouched so `MarkdownCodeBlock` / `CodeHighlighter` receives the raw source
 * text for both copying and search highlighting.
 */
const OPAQUE_TAG_NAMES = new Set(["mark", "pre"]);

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
  useLocale();

  const components = useMemo(
    () => (highlightQuery ? createMarkdownComponents(highlightQuery) : defaultMarkdownComponents),
    [highlightQuery],
  );

  const rehypePlugins = useMemo<Options["rehypePlugins"]>(() => {
    const pattern = buildHighlightPattern(highlightQuery);
    return pattern ? [[rehypeHighlightTerms, pattern]] : undefined;
  }, [highlightQuery]);

  return (
    <ProgressiveText text={text} initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.markdown}>
      {(visibleText) => {
        const truncated = visibleText.length < text.length;
        // The Markdown parser excludes the leading BOM from node positions.
        const preview = truncated ? visibleText.replace(/^\uFEFF/u, "") : undefined;
        const partialLine =
          preview !== undefined && !/[\r\n]/u.test(text.charAt(visibleText.length));
        return (
          <div>
            <ReactMarkdown
              components={
                preview === undefined
                  ? components
                  : createMarkdownComponents(highlightQuery, preview)
              }
              remarkPlugins={
                partialLine
                  ? [
                      ...remarkPlugins,
                      [
                        omitIncompleteDefinition,
                        Math.max(preview.lastIndexOf("\n"), preview.lastIndexOf("\r")) + 1,
                      ],
                    ]
                  : remarkPlugins
              }
              rehypePlugins={rehypePlugins}
              urlTransform={transformMarkdownUrl}
            >
              {visibleText}
            </ReactMarkdown>
          </div>
        );
      }}
    </ProgressiveText>
  );
});
