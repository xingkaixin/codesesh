/**
 * The single source of truth for diff line colouring. Both the unified and the
 * structured diff renderers map their own line shape onto a `DiffTone` and let
 * the `--diff-*` tokens decide the colours, so light and dark never fork here.
 */
export type DiffTone = "add" | "remove" | "hunk" | "meta" | "header" | "context";

const TONE_CLASS: Record<DiffTone, string> = {
  add: "text-[var(--diff-add-fg)] bg-[var(--diff-add-bg)]",
  remove: "text-[var(--diff-remove-fg)] bg-[var(--diff-remove-bg)]",
  hunk: "text-[var(--diff-hunk-fg)] bg-[var(--diff-hunk-bg)]",
  meta: "text-[var(--diff-meta-fg)] bg-[var(--diff-meta-bg)]",
  header: "text-[var(--console-text)] bg-[var(--diff-header-bg)]",
  context: "text-[var(--console-text)]",
};

export function diffToneClass(tone: DiffTone): string {
  return TONE_CLASS[tone];
}
