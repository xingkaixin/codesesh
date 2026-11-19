import { buildHighlightPattern, matchesHighlightPattern } from "../../lib/search-highlight";
import { buildBlockTimelineAnchorId, buildMessageTimelineAnchorId } from "./timeline";
import type { FilteredSessionMessage } from "./toc";

export interface LoadedSessionFindMatch {
  kind: "loaded";
  displayMessageIndex: number;
  anchorId: string;
}

export interface UnpagedSessionFindMatch {
  kind: "unpaged";
  sourceMessageIndex: number;
}

export type SessionFindMatch = LoadedSessionFindMatch | UnpagedSessionFindMatch;

interface ParsedSessionFindQuery {
  terms: string[];
  any: boolean;
  pattern: RegExp | null;
}

function parseSessionFindQuery(query: string): ParsedSessionFindQuery {
  const normalized = query.trim();
  if (!normalized) return { terms: [], any: false, pattern: null };

  const rawTokens = normalized.match(/"[^"]+"|\S+/g) ?? [];
  const any = rawTokens.some((token) => /^OR$/i.test(token));
  const terms = Array.from(
    new Set(
      rawTokens
        .filter((token) => !/^OR$/i.test(token))
        .map((token) => token.replace(/^"|"$/g, "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  return {
    terms,
    any,
    pattern: buildHighlightPattern(normalized),
  };
}

function appendValueText(value: unknown, out: string[], depth = 0): void {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendValueText(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) appendValueText(nested, out, depth + 1);
  }
}

function matchesParsedQuery(text: string, parsed: ParsedSessionFindQuery): boolean {
  if (parsed.terms.length === 0 || !text) return false;
  const lower = text.toLowerCase();
  return parsed.any
    ? parsed.terms.some((term) => lower.includes(term))
    : parsed.terms.every((term) => lower.includes(term));
}

export function collectLoadedSessionFindMatches(
  messages: FilteredSessionMessage[],
  query: string,
): LoadedSessionFindMatch[] {
  const parsed = parseSessionFindQuery(query);
  if (parsed.terms.length === 0) return [];

  const matches: LoadedSessionFindMatch[] = [];

  for (const { msg, blocks, index: displayMessageIndex } of messages) {
    const isUser = msg.role === "user";
    const userAnchorId = isUser ? buildMessageTimelineAnchorId(displayMessageIndex) : undefined;
    const messageSegments: string[] = [];
    let firstAnchorId: string | undefined = userAnchorId;
    let matchedAnchorId: string | undefined;

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]!;
      const blockAnchorId =
        userAnchorId ?? buildBlockTimelineAnchorId(displayMessageIndex, blockIndex);
      if (!firstAnchorId) firstAnchorId = blockAnchorId;

      if (block.type === "tool") {
        for (let partIndex = 0; partIndex < block.parts.length; partIndex += 1) {
          const tool = block.parts[partIndex]!;
          const partSegments: string[] = [];
          if (tool.tool) partSegments.push(tool.tool);
          if (tool.title) partSegments.push(tool.title);
          appendValueText(tool.state.input, partSegments);
          appendValueText(tool.state.output, partSegments);
          appendValueText(tool.state.error, partSegments);
          appendValueText(tool.state.metadata, partSegments);
          const partText = partSegments.join("\n");
          if (partText) {
            messageSegments.push(partText);
            if (!matchedAnchorId && matchesHighlightPattern(partText, parsed.pattern)) {
              matchedAnchorId = userAnchorId ?? block.anchorIds?.[partIndex] ?? blockAnchorId;
            }
          }
        }
      } else {
        const blockSegments: string[] = [];
        for (const part of block.parts) {
          if (part.text) blockSegments.push(part.text);
        }
        const blockText = blockSegments.join("\n");
        if (blockText) {
          messageSegments.push(blockText);
          if (!matchedAnchorId && matchesHighlightPattern(blockText, parsed.pattern)) {
            matchedAnchorId = blockAnchorId;
          }
        }
      }
    }

    if (messageSegments.length === 0) continue;
    if (!matchesParsedQuery(messageSegments.join("\n"), parsed)) continue;

    const anchorId = matchedAnchorId ?? firstAnchorId;
    if (anchorId) {
      matches.push({ kind: "loaded", displayMessageIndex, anchorId });
    }
  }

  return matches;
}
