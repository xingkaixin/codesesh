import { t } from "../../../i18n/translate";
/**
 * Codex tool display strategy — exec_command/write_stdin/request_user_input/
 * patch/subagent/js(node_repl)/skill rendering, plus its exec-command helpers.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
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
} from "../../ui/icons";

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

export function buildCodexToolStrategy(
  tool: ToolPart,
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
      title: t("Browser"),
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
      title: t("update plan"),
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      contentLabel: t("Plan"),
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
      title: t("view image"),
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
    const input = toRecord(state.inputValue);
    const taskName = compactText(input.task_name);
    const model = compactText(input.model);
    const reasoningEffort = compactText(input.reasoning_effort);
    const forkTurns = compactText(input.fork_turns);
    const isPriority = compactText(input.service_tier) === "priority";
    const fallbackText = getOutputOrErrorText(state);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: taskName || getToolTitle(tool, "subagent"),
      secondaryText: undefined,
      details: [
        model ? { label: t("Model"), value: isPriority ? t("{0} · Fast", [model]) : model } : null,
        reasoningEffort ? { label: t("Effort"), value: reasoningEffort } : null,
        forkTurns ? { label: t("Fork"), value: forkTurns } : null,
      ].filter((d): d is NonNullable<typeof d> => d !== null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: fallbackText,
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
      title: toolKey.endsWith("followup_task") ? t("follow up with agent") : t("message agent"),
      secondaryText: target || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: t("Message"),
      outputContent: {
        kind: "property-list",
        items: [
          target ? { label: t("Recipient"), value: target } : null,
          message ? { label: t("Message"), value: message } : null,
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
      title: t("wait for agents"),
      secondaryText:
        typeof timeout === "number" ? t("{0}s timeout", [Math.round(timeout / 1000)]) : undefined,
      details: [],
      showInputPreview: false,
      contentLabel: t("Agent updates"),
    };
  }

  if (toolKey === "collaboration.list_agents") {
    return {
      ...defaultStrategy,
      Icon: Users,
      title: t("list agents"),
      secondaryText: undefined,
      details: [],
      showInputPreview: false,
      contentLabel: t("Agent tree"),
    };
  }

  if (toolKey === "collaboration.interrupt_agent") {
    const target = toPlainText(toRecord(state.inputValue).target);
    return {
      ...defaultStrategy,
      Icon: Users,
      title: t("interrupt agent"),
      secondaryText: target || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: t("Result"),
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
      contentLabel: t("Goal state"),
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
      contentLabel: semanticOutput ? t("Result") : t("Request"),
      outputContent:
        semanticOutput ??
        (semanticInput.length > 0
          ? { kind: "property-list", items: semanticInput }
          : defaultStrategy.outputContent),
    };
  }

  return defaultStrategy;
}
