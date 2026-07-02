/**
 * Codex tool display strategy — exec_command/write_stdin/request_user_input/
 * patch/subagent/js(node_repl)/skill rendering, plus its exec-command helpers.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { MessagePart } from "../../../lib/api";
import { detectLanguageByFilePath } from "../../tool-output/language";
import {
  buildCodexExecCommandDisplay,
  buildCodexRequestUserInputDisplay,
  buildCodexWriteStdinDisplay,
} from "../codex-tool";
import {
  buildCodexPatchOutputContent,
  getCodexPatchEntries,
  summarizeCodexPatchEntries,
} from "../codex-patch";
import { getDisplayPath, getDisplayTextWithRelativePaths } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  compactText,
  getOutputOrErrorText,
  getToolTitle,
  normalizeToolName,
  toPlainText,
  toRecord,
} from "../tool-normalize";
import { parseJsonText } from "../utils";
import { buildDefaultToolStrategy, buildSkillToolStrategy } from "./shared";
import { Bot, CircleHelp, FilePenLine, SquareTerminal } from "lucide-react";

export function extractCodexNodeReplTextOutput(outputText: string) {
  const marker = "Output:\n";
  const markerIndex = outputText.indexOf(marker);
  if (markerIndex === -1) return outputText;

  const rawOutput = outputText.slice(markerIndex + marker.length).trim();
  const parsed = parseJsonText<unknown>(rawOutput);
  if (!Array.isArray(parsed)) return outputText;

  const text = parsed
    .map((item) => toPlainText(toRecord(item).text))
    .filter(Boolean)
    .join("\n");
  return text || outputText;
}

function getSubagentToolTitle(part: MessagePart) {
  const state = toRecord(part.state);
  const argumentsValue = toRecord(state.arguments);
  const agentType = compactText(argumentsValue.agent_type);
  const nickname = compactText((part as { nickname?: unknown }).nickname);
  const model = compactText(argumentsValue.model);
  const reasoningEffort = compactText(argumentsValue.reasoning_effort);
  const modelSuffix = [model, reasoningEffort].filter(Boolean).join("-");
  const left = [agentType, nickname].filter(Boolean).join(" - ");
  return [left, modelSuffix].filter(Boolean).join(" ");
}

function getSubagentPrompt(part: MessagePart) {
  const state = toRecord(part.state);
  const prompt = compactText(state.prompt);
  if (prompt) return prompt;

  const argumentsValue = toRecord(state.arguments);
  const message = compactText(argumentsValue.message);
  if (message) return message;

  return "";
}

export function buildCodexToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = normalizeToolName(tool);
  const metadata = toRecord(state.metadataValue);
  const namespace = toPlainText(metadata.namespace);
  const formatPathForDisplay = (path: string) => getDisplayPath(path, baseDirectory);
  const formatTextForDisplay = (text: string) =>
    getDisplayTextWithRelativePaths(text, baseDirectory);

  if (toolKey === "skill") {
    return buildSkillToolStrategy(tool, state, defaultStrategy, baseDirectory);
  }

  if (
    toolKey === "js" &&
    (namespace === "mcp__node_repl__" || namespace === "mcp__node_repl__.js")
  ) {
    const input = toRecord(state.inputValue);
    const title = toPlainText(input.title);
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "Browser",
      secondaryText: title || undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractCodexNodeReplTextOutput(getOutputOrErrorText(state)),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "exec_command" || toolKey === "bash") {
    const display = buildCodexExecCommandDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
      detectLanguageByFilePath,
      formatPathForDisplay,
      formatTextForDisplay,
    );
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: display.outputAnalysis.text,
        language: display.outputAnalysis.language,
        isCode: display.outputAnalysis.isCode,
      },
    };
  }

  if (toolKey === "write_stdin") {
    const display = buildCodexWriteStdinDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
      detectLanguageByFilePath,
    );
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: display.outputAnalysis.text,
        language: display.outputAnalysis.language,
        isCode: display.outputAnalysis.isCode,
      },
    };
  }

  if (toolKey === "request_user_input") {
    const display = buildCodexRequestUserInputDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
    );
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      title: "ask",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: display.outputContent,
    };
  }

  if (toolKey === "patch") {
    const entries = getCodexPatchEntries(state.inputValue);
    const summary = summarizeCodexPatchEntries(entries);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: getToolTitle(tool, "patch"),
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: false,
      outputContent: buildCodexPatchOutputContent(
        entries,
        getOutputOrErrorText(state),
        detectLanguageByFilePath,
        formatPathForDisplay,
      ),
    };
  }

  if (toolKey === "subagent") {
    const prompt = getSubagentPrompt(tool);
    const fallbackText = getOutputOrErrorText(state);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: getSubagentToolTitle(tool) || getToolTitle(tool, "subagent"),
      secondaryText: undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: prompt || fallbackText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  return defaultStrategy;
}
