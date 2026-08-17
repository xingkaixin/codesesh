export interface ContentRenderBudget {
  maxCharacters: number;
  maxLines: number;
}

export interface TextRenderPreview {
  text: string;
  renderedCharacters: number;
  renderedLines: number;
  truncated: boolean;
}

export const INITIAL_CONTENT_RENDER_BUDGETS = {
  markdown: { maxCharacters: 24_000, maxLines: 400 },
  code: { maxCharacters: 32_000, maxLines: 600 },
  diff: { maxCharacters: 64_000, maxLines: 800 },
  plain: { maxCharacters: 64_000, maxLines: 1_000 },
} as const satisfies Record<string, ContentRenderBudget>;

export function buildTextRenderPreview(
  text: string,
  budget: ContentRenderBudget,
): TextRenderPreview {
  if (!text) {
    return { text, renderedCharacters: 0, renderedLines: 0, truncated: false };
  }

  const maxCharacters = Math.max(1, Math.min(text.length, Math.trunc(budget.maxCharacters)));
  const maxLines = Math.max(1, Math.min(text.length + 1, Math.trunc(budget.maxLines)));
  let end = maxCharacters;
  let renderedLines = 1;

  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (renderedLines === maxLines) {
      end = index;
      break;
    }
    renderedLines += 1;
  }

  if (end > 0 && end < text.length && text.charCodeAt(end - 1) === 13) end -= 1;
  if (end > 0 && end < text.length && text.charCodeAt(end - 1) >= 0xd800) {
    const lastCodeUnit = text.charCodeAt(end - 1);
    if (lastCodeUnit <= 0xdbff) end -= 1;
  }

  return {
    text: text.slice(0, end),
    renderedCharacters: end,
    renderedLines,
    truncated: end < text.length,
  };
}

export function growContentRenderBudget(
  current: ContentRenderBudget,
  totalCharacters: number,
  totalLines = totalCharacters + 1,
): ContentRenderBudget {
  const grow = (value: number, total: number) =>
    value >= Math.ceil(total / 2) ? total : value * 2;
  return {
    maxCharacters: grow(current.maxCharacters, Math.max(1, totalCharacters)),
    maxLines: grow(current.maxLines, Math.max(1, totalLines)),
  };
}
