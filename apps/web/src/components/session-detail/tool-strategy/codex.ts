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
  buildCodexUpdatePlanDisplay,
  buildCodexViewImageDisplay,
  buildCodexWebRunDisplay,
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
  buildSemanticOutputContent,
  compactText,
  getOutputOrErrorText,
  getToolTitle,
  normalizeToolName,
  toPlainText,
  toRecord,
} from "../tool-normalize";
import { parseJsonText } from "../utils";
import { buildDefaultToolStrategy, buildSkillToolStrategy } from "./shared";
import {
  Bot,
  Clock3,
  CircleHelp,
  FilePenLine,
  FileSearch,
  Image as ImageIcon,
  ListTodo,
  MessageSquareMore,
  Plug,
  SquareTerminal,
  Target,
  Users,
} from "lucide-react";

function humanizeToolName(value: string) {
  return value.replace(/^_+/, "").replaceAll("_", " ");
}

function firstSummaryValue(input: Record<string, unknown>) {
  const keys = ["title", "summary", "query", "q", "url", "objective", "target", "threadId"];
  for (const key of keys) {
    const value = compactText(input[key]);
    if (value) return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  return "";
}

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

  if (toolKey === "update_plan") {
    const display = buildCodexUpdatePlanDisplay(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: "update plan",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      contentLabel: "Plan",
      outputContent: { kind: "task-list", items: display.items },
    };
  }

  if (toolKey === "web__run") {
    const display = buildCodexWebRunDisplay(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: display.title,
      secondaryText: display.secondaryText,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "view_image") {
    const display = buildCodexViewImageDisplay(state.inputValue, formatPathForDisplay);
    return {
      ...defaultStrategy,
      Icon: ImageIcon,
      title: "view image",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
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

  if (toolKey === "collaboration.send_message" || toolKey === "collaboration.followup_task") {
    const input = toRecord(state.inputValue);
    const target = toPlainText(input.target);
    const message = toPlainText(input.message);
    return {
      ...defaultStrategy,
      Icon: MessageSquareMore,
      title: toolKey.endsWith("followup_task") ? "follow up with agent" : "message agent",
      secondaryText: target || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Message",
      outputContent: {
        kind: "property-list",
        items: [
          target ? { label: "Recipient", value: target } : null,
          message ? { label: "Message", value: message } : null,
        ].filter((item): item is { label: string; value: string } => item != null),
      },
    };
  }

  if (toolKey === "collaboration.wait_agent" || toolKey === "wait") {
    const input = toRecord(state.inputValue);
    const timeout = input.timeout_ms;
    return {
      ...defaultStrategy,
      Icon: Clock3,
      title: "wait for agents",
      secondaryText:
        typeof timeout === "number" ? `${Math.round(timeout / 1000)}s timeout` : undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Agent updates",
    };
  }

  if (toolKey === "collaboration.list_agents") {
    return {
      ...defaultStrategy,
      Icon: Users,
      title: "list agents",
      secondaryText: undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Agent tree",
    };
  }

  if (toolKey === "collaboration.interrupt_agent") {
    const target = toPlainText(toRecord(state.inputValue).target);
    return {
      ...defaultStrategy,
      Icon: Users,
      title: "interrupt agent",
      secondaryText: target || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Result",
    };
  }

  if (toolKey === "create_goal" || toolKey === "get_goal" || toolKey === "update_goal") {
    const input = toRecord(state.inputValue);
    return {
      ...defaultStrategy,
      Icon: Target,
      title: humanizeToolName(toolKey),
      secondaryText: toPlainText(input.objective) || toPlainText(input.status) || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Goal state",
    };
  }

  if (namespace.startsWith("mcp__") || toolKey.includes("._")) {
    const input = toRecord(state.inputValue);
    const [provider, operation = "tool"] = toolKey.split(".", 2);
    const semanticInput = Object.entries(input).map(([label, value]) => ({ label, value }));
    const semanticOutput = buildSemanticOutputContent(state.outputValue);
    return {
      ...defaultStrategy,
      Icon: Plug,
      title: `${humanizeToolName(provider ?? "integration")} · ${humanizeToolName(operation)}`,
      secondaryText: firstSummaryValue(input) || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: semanticOutput ? "Result" : "Request",
      outputContent:
        semanticOutput ??
        (semanticInput.length > 0
          ? { kind: "property-list", items: semanticInput }
          : defaultStrategy.outputContent),
    };
  }

  return defaultStrategy;
}
