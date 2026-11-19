function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildHighlightPattern(query?: string): RegExp | null {
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

export function matchesHighlightPattern(text: string, pattern: RegExp | null): boolean {
  if (!pattern || !text) return false;
  pattern.lastIndex = 0;
  return pattern.test(text);
}

export function valueMatchesHighlight(value: unknown, pattern: RegExp | null, depth = 0): boolean {
  if (!pattern || value == null || depth > 8) return false;
  if (typeof value === "string") return matchesHighlightPattern(value, pattern);
  if (typeof value === "number" || typeof value === "boolean") {
    return matchesHighlightPattern(String(value), pattern);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueMatchesHighlight(item, pattern, depth + 1));
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) {
      if (valueMatchesHighlight(nested, pattern, depth + 1)) return true;
    }
  }
  return false;
}
