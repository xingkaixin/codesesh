/**
 * Tool display strategies — per-agent builders that turn a NormalizedToolState
 * into a ToolDisplayStrategy (icon, title, details, output content with diff).
 *
 * This is the registry entry point: getToolDisplayStrategy dispatches by
 * agentKey to the builder in the matching ./<agent>.ts file. Common
 * infrastructure lives in ./shared.ts (default/skill/file strategies and
 * extractors shared by 2+ agents); agent-agnostic normalization
 * (normalizeToolState, normalizeMessagesForDisplay) lives in
 * ../tool-normalize.ts.
 *
 * Pure logic — no React. Consumed by SessionDetail's ToolItem / MessageItem.
 */
import type { ToolPart } from "../../../lib/api";
import type { NormalizedToolState, ToolDisplayStrategy } from "../tool-normalize";
import { buildClaudeToolStrategy } from "./claudecode";
import { buildOpencodeToolStrategy } from "./opencode";
import { buildKimiToolStrategy } from "./kimi";
import { buildKimiCodeToolStrategy } from "./kimi-code";
import { buildZCodeToolStrategy } from "./zcode";
import { buildCodexToolStrategy } from "./codex";
import { buildCursorToolStrategy } from "./cursor";
import { buildGrokToolStrategy } from "./grok";
import { buildPiToolStrategy } from "./pi";
import { buildDshToolStrategy } from "./dsh";
import { buildDefaultToolStrategy } from "./shared";

export type { NormalizedToolState, ToolDisplayStrategy, ToolStatus } from "../tool-normalize";
export {
  getAssistantDisplayLabel,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "../tool-normalize";
export {
  buildDefaultToolStrategy,
  buildSkillToolStrategy,
  extractReadContent,
  extractWriteContent,
} from "./shared";

type ToolStrategyBuilder = (
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
) => ToolDisplayStrategy;

// Registered agents declare custom/default explicitly; the cross-package completeness
// test keeps that declaration aligned with this map. Unknown future agents still get
// a safe default renderer when an older web bundle reads a newer server response.
const TOOL_STRATEGY_BUILDERS: Record<string, ToolStrategyBuilder> = {
  claudecode: buildClaudeToolStrategy,
  opencode: buildOpencodeToolStrategy,
  kimi: buildKimiToolStrategy,
  "kimi-code": buildKimiCodeToolStrategy,
  codex: buildCodexToolStrategy,
  cursor: buildCursorToolStrategy,
  grok: buildGrokToolStrategy,
  pi: buildPiToolStrategy,
  zcode: buildZCodeToolStrategy,
  dsh: buildDshToolStrategy,
};

export function hasCustomToolStrategy(agentName: string): boolean {
  return Object.hasOwn(TOOL_STRATEGY_BUILDERS, agentName.toLowerCase());
}

export function getToolDisplayStrategy(
  sessionAgentKey: string,
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const builder = TOOL_STRATEGY_BUILDERS[sessionAgentKey.toLowerCase()] ?? buildDefaultToolStrategy;
  return builder(tool, state, baseDirectory);
}
