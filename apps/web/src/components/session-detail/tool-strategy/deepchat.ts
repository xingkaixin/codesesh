import type { ToolPart } from "../../../lib/api";
import type { NormalizedToolState, ToolDisplayStrategy } from "../tool-normalize";
import { normalizeToolName } from "../tool-normalize";
import { buildCodeExecutionStrategy } from "./code-execution";
import { buildDefaultToolStrategy } from "./shared";

export function buildDeepChatToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  return normalizeToolName(tool) === "run_code"
    ? buildCodeExecutionStrategy(tool, state, "typescript")
    : buildDefaultToolStrategy(tool, state, baseDirectory);
}
