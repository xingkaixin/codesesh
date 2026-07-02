/**
 * Tool display strategies — per-agent builders that turn a NormalizedToolState
 * into a ToolDisplayStrategy (icon, title, details, output content with diff).
 *
 * This is the registry entry point: getToolDisplayStrategy dispatches by
 * agentKey to the builder in the matching ./<agent>.ts file. Common
 * infrastructure lives in ./shared.ts (default/skill strategies, extractors
 * shared by 2+ agents); agent-agnostic normalization (normalizeToolState,
 * normalizeMessagesForDisplay) lives in ../tool-normalize.ts.
 *
 * Pure logic — no React. Consumed by SessionDetail's ToolItem / MessageItem.
 */
import type { MessagePart } from "../../../lib/api";
import type { NormalizedToolState, ToolDisplayStrategy } from "../tool-normalize";
import { buildClaudeToolStrategy } from "./claudecode";
import { buildOpencodeToolStrategy } from "./opencode";
import { buildKimiToolStrategy } from "./kimi";
import { buildCodexToolStrategy } from "./codex";
import { buildCursorToolStrategy } from "./cursor";
import { buildPiToolStrategy } from "./pi";
import { buildZCodeToolStrategy } from "./zcode";
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
export { buildClaudeToolStrategy } from "./claudecode";
export { buildOpencodeToolStrategy } from "./opencode";
export { buildKimiToolStrategy } from "./kimi";
export { buildCodexToolStrategy, extractCodexNodeReplTextOutput } from "./codex";
export { buildCursorToolStrategy } from "./cursor";
export { buildPiToolStrategy } from "./pi";
export { buildZCodeToolStrategy } from "./zcode";

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
