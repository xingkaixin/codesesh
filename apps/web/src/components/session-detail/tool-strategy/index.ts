/**
 * Tool display strategies — per-agent builders that turn a NormalizedToolState
 * into a ToolDisplayStrategy (icon, title, details, output content with diff).
 *
 * This is the registry entry point: getToolDisplayStrategy dispatches by
 * agentKey to the builder in the matching ./<agent>.ts file. Common
 * infrastructure (normalizeToolState, normalizeMessagesForDisplay, the
 * default/skill strategies, and extractors shared by 2+ agents) lives in
 * ./shared.ts.
 *
 * cursor/pi/zcode builders have not moved yet (CS-19 step 2) — imported here
 * from the legacy ../tool-strategy shell in the meantime.
 *
 * Pure logic — no React. Consumed by SessionDetail's ToolItem / MessageItem.
 */
import type { MessagePart } from "../../../lib/api";
import type { NormalizedToolState, ToolDisplayStrategy } from "../tool-normalize";
import { buildClaudeToolStrategy } from "./claudecode";
import { buildOpencodeToolStrategy } from "./opencode";
import { buildKimiToolStrategy } from "./kimi";
import { buildCodexToolStrategy } from "./codex";
import {
  buildCursorToolStrategy,
  buildPiToolStrategy,
  buildZCodeToolStrategy,
} from "../tool-strategy";
import { buildDefaultToolStrategy } from "./shared";

export type { NormalizedToolState, ToolDisplayStrategy, ToolStatus } from "../tool-normalize";
export {
  buildDefaultToolStrategy,
  buildSkillToolStrategy,
  extractReadContent,
  extractWriteContent,
  getAssistantDisplayLabel,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "./shared";
export { buildClaudeToolStrategy } from "./claudecode";
export { buildOpencodeToolStrategy } from "./opencode";
export { buildKimiToolStrategy } from "./kimi";
export { buildCodexToolStrategy, extractCodexNodeReplTextOutput } from "./codex";

type ToolStrategyBuilder = (
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
) => ToolDisplayStrategy;

// agentKey → 展示策略 builder。新增 agent 时在此登记一行；值类型保证 builder
// 签名一致，未登记的 agent 走 buildDefaultToolStrategy 兜底（默认渲染，非错误）。
const TOOL_STRATEGY_BUILDERS: Record<string, ToolStrategyBuilder> = {
  claudecode: buildClaudeToolStrategy,
  opencode: buildOpencodeToolStrategy,
  kimi: buildKimiToolStrategy,
  codex: buildCodexToolStrategy,
  cursor: buildCursorToolStrategy,
  pi: buildPiToolStrategy,
  zcode: buildZCodeToolStrategy,
};

export function getToolDisplayStrategy(
  sessionAgentKey: string,
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const builder = TOOL_STRATEGY_BUILDERS[sessionAgentKey.toLowerCase()] ?? buildDefaultToolStrategy;
  return builder(tool, state, baseDirectory);
}
