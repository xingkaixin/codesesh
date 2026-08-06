import type { CSSProperties } from "react";

/**
 * The CodeSesh syntax theme for `react-syntax-highlighter`.
 *
 * Every colour is a `var(--code-*)` reference, so a single object serves both
 * light and dark: the tokens flip with `.dark` on `<html>` and the highlighter
 * never has to know which mode is resolved.
 */

const CODE_BASE: CSSProperties = {
  background: "var(--code-bg)",
  color: "var(--code-fg)",
  fontFamily: "var(--font-mono)",
  direction: "ltr",
  textAlign: "left",
  whiteSpace: "pre",
  wordSpacing: "normal",
  wordBreak: "normal",
  tabSize: 2,
  hyphens: "none",
};

function paint(color: string, ...tokens: string[]): Record<string, CSSProperties> {
  return Object.fromEntries(tokens.map((token) => [token, { color }]));
}

export const codeseshPrismTheme: Record<string, CSSProperties> = {
  'code[class*="language-"]': CODE_BASE,
  'pre[class*="language-"]': { ...CODE_BASE, margin: 0, overflow: "auto", padding: "1em" },
  comment: { color: "var(--code-comment)", fontStyle: "italic" },
  ...paint("var(--code-comment)", "prolog", "cdata", "doctype"),
  ...paint("var(--code-punctuation)", "punctuation", "operator", "entity"),
  ...paint("var(--code-keyword)", "keyword", "atrule", "rule", "important", "selector"),
  ...paint("var(--code-string)", "string", "char", "attr-value", "regex", "url", "builtin"),
  ...paint("var(--code-number)", "number", "boolean", "constant", "symbol"),
  ...paint("var(--code-function)", "function", "class-name", "attr-name", "tag", "namespace"),
  ...paint("var(--code-variable)", "variable", "property", "parameter"),
  ...paint("var(--code-deleted)", "deleted"),
  ...paint("var(--code-inserted)", "inserted"),
  bold: { fontWeight: "bold" },
  italic: { fontStyle: "italic" },
};
