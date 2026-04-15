import { basename } from "node:path";

const TITLE_MAX_LENGTH = 100;
const UNTITLED_SESSION = "Untitled Session";

/** Normalize extracted title text for display. */
export function normalizeTitleText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, TITLE_MAX_LENGTH);
}

/** Return a stable basename for fallback title. */
export function basenameTitle(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.trim().replace(/[/\\]+$/, "");
  if (!normalized) return null;
  const name = basename(normalized).trim();
  return name || null;
}

/** Resolve final session title from explicit, message, and directory fallbacks. */
export function resolveSessionTitle(
  explicit: string | null | undefined,
  message: string | null | undefined,
  directory: string | null | undefined,
): string {
  for (const candidate of [explicit, message, directory]) {
    if (candidate) {
      const normalized = normalizeTitleText(candidate);
      if (normalized) return normalized;
    }
  }
  return UNTITLED_SESSION;
}
