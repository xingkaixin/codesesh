/**
 * Kimi-Code tool display strategy.
 *
 * Kimi-Code uses the same native workflow tool vocabulary as ZCode, while its
 * agent adapter and transcript format remain independent. Normalize from the
 * raw tool name so persisted display titles cannot hide the tool semantics.
 */
import type { ToolPart } from "../../../lib/api";
import type { NormalizedToolState, ToolDisplayStrategy } from "../tool-normalize";
import { buildZCodeToolStrategy } from "./zcode";

export function buildKimiCodeToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  return buildZCodeToolStrategy({ ...tool, title: "" }, state, baseDirectory);
}
