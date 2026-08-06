/**
 * Type metrics shared by `CodeHighlighter`'s plain-text fallback and the lazy
 * `PrismHighlighter`, so the lazy-load swap does not visibly reflow the block.
 *
 * It lives apart from `styles/prism-theme.ts` on purpose: the eager fallback
 * must not pull the theme into the session-detail chunk (see
 * `tests/initial-bundle.test.ts`).
 */
export const CODE_METRICS = { fontSize: "0.75rem", lineHeight: 1.55 } as const;
