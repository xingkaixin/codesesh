/**
 * Claude Code tool display strategy — read/edit/write rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { MessagePart } from "../../../lib/api";
import { detectLanguageByFilePath } from "../../tool-output/language";
import type { TaskListItem } from "../../tool-output/types";
import { buildStructuredDiffFromTexts } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  buildSemanticOutputContent,
  compactText,
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
  getToolTitle,
  parseInputCandidate,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { getDisplayTextWithRelativePaths } from "../path-extract";
import { buildDefaultToolStrategy, extractReadContent, extractWriteContent } from "./shared";
import {
  Bot,
  BookOpenText,
  CircleHelp,
  FilePenLine,
  FileSearch,
  ListTodo,
  MessageSquareMore,
  NotebookPen,
  PanelsTopLeft,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";

function summarizeTasks(items: unknown[]) {
  const counts = new Map<string, number>();
  const tasks = items.map((value) => {
    const item = toRecord(value);
    const statusValue = toStringValue(item.status);
    const status: TaskListItem["status"] =
      statusValue === "completed" || statusValue === "in_progress" || statusValue === "error"
        ? statusValue
        : "pending";
    counts.set(status, (counts.get(status) ?? 0) + 1);
    return {
      label: toStringValue(item.content) || toStringValue(item.subject) || "Untitled task",
      status,
      detail: toStringValue(item.activeForm) || toStringValue(item.description) || undefined,
    };
  });
  return {
    tasks,
    summary: [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · "),
  };
}

function buildQuestionOutput(input: Record<string, unknown>, outputText: string) {
  const answerMatches = [...outputText.matchAll(/"([^"]+)"="([^"]+)"/g)];
  const answers = new Map(answerMatches.map((match) => [match[1], [match[2]] as string[]]));
  const questions = (Array.isArray(input.questions) ? input.questions : []).flatMap((value) => {
    const question = toRecord(value);
    const questionText = toStringValue(question.question);
    if (!questionText) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap(
      (optionValue) => {
        const option = toRecord(optionValue);
        const rawLabel = toStringValue(option.label);
        if (!rawLabel) return [];
        const label = rawLabel.replace(/\s*\(Recommended\)\s*$/i, "");
        return [
          {
            label,
            description: toStringValue(option.description) || undefined,
            recommended: label !== rawLabel || undefined,
          },
        ];
      },
    );
    return [
      {
        header: toStringValue(question.header) || undefined,
        question: questionText,
        options,
        answers: answers.get(questionText) ?? [],
      },
    ];
  });
  return questions;
}

function claudeToolKey(tool: MessagePart) {
  return (tool.tool || "").trim().toLowerCase();
}

function displayValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function buildSendMessageOutput(input: Record<string, unknown>, state: NormalizedToolState) {
  const resultText = getOutputOrErrorText(state);
  const result = toRecord(parseInputCandidate(resultText));
  const delivery = toStringValue(result.message) || resultText;
  const items = [
    { label: "Recipient", value: toStringValue(input.recipient) || toStringValue(input.to) },
    { label: "Summary", value: toStringValue(input.summary) },
    { label: "Message", value: toStringValue(input.message) || toStringValue(input.content) },
    { label: "Delivery", value: delivery },
  ];
  return items.filter((item) => item.value && item.value !== "No output captured.");
}

export function buildClaudeToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = claudeToolKey(tool);
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "read") {
    const semanticOutput = buildSemanticOutputContent(state.outputValue);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: "read",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent:
        semanticOutput ??
        ({
          kind: "plain",
          text: extractReadContent(state.outputValue),
          language: detectLanguageByFilePath(filePath),
          isCode: true,
        } as const),
    };
  }

  if (toolKey === "edit") {
    const oldValue = toStringValue(input.old_string);
    const newValue = toStringValue(input.new_string);
    const diffBlocks = buildStructuredDiffFromTexts(displayPath || filePath, oldValue, newValue);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
    };
  }

  if (toolKey === "write") {
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: "write",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  if (toolKey === "bash" || toolKey === "workflow") {
    const command = toStringValue(input.command) || toStringValue(input.script);
    const description = toStringValue(input.description);
    const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: toolKey === "workflow" ? "workflow" : "bash",
      secondaryText: description || compactText(displayCommand).slice(0, 120) || undefined,
      details: command
        ? [{ label: toolKey === "workflow" ? "Script" : "Command", value: displayCommand }]
        : [],
      showInputPreview: false,
      contentLabel: state.status === "error" ? "Error" : "Terminal output",
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "todowrite" || toolKey === "taskcreate") {
    const rawTasks =
      toolKey === "todowrite" ? (Array.isArray(input.todos) ? input.todos : []) : [input];
    const taskDisplay = summarizeTasks(rawTasks);
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: toolKey === "todowrite" ? "tasks" : "create task",
      secondaryText: taskDisplay.summary || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Task state",
      outputContent: { kind: "task-list", items: taskDisplay.tasks },
    };
  }

  if (toolKey === "taskupdate" || toolKey === "tasklist") {
    const structured = buildSemanticOutputContent(
      toolKey === "taskupdate" ? input : state.outputValue,
    );
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: toolKey === "taskupdate" ? "update task" : "list tasks",
      secondaryText: toStringValue(input.taskId) || toStringValue(input.status) || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Task state",
      outputContent: structured ?? {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "agent") {
    const agentType = toStringValue(input.subagent_type) || toStringValue(input.name);
    const description = toStringValue(input.description);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: agentType ? `agent · ${agentType}` : "agent",
      secondaryText: description || undefined,
      details: [
        toStringValue(input.model) ? { label: "Model", value: toStringValue(input.model) } : null,
        input.run_in_background === true ? { label: "Mode", value: "Background" } : null,
      ].filter((item): item is { label: string; value: string } => item != null),
      showInputPreview: false,
      contentLabel: "Agent result",
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "askuserquestion") {
    const questions = buildQuestionOutput(input, getOutputOrErrorText(state));
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      title: "ask",
      secondaryText: questions.length
        ? `${questions.length} question${questions.length === 1 ? "" : "s"}`
        : undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Questions",
      outputContent: questions.length
        ? { kind: "question-list", questions }
        : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
    };
  }

  if (toolKey === "websearch" || toolKey === "webfetch") {
    const query = toStringValue(input.query);
    const url = toStringValue(input.url);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: toolKey === "websearch" ? "web search" : "web fetch",
      secondaryText: query || url || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Results",
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "toolsearch") {
    return {
      ...defaultStrategy,
      Icon: Search,
      title: "find tools",
      secondaryText: toStringValue(input.query) || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Matches",
    };
  }

  if (toolKey === "skill") {
    return {
      ...defaultStrategy,
      Icon: Wrench,
      title: "skill",
      secondaryText: toStringValue(input.skill) || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Result",
    };
  }

  if (toolKey === "structuredoutput" || toolKey === "reportfindings") {
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: toolKey === "reportfindings" ? "report findings" : "structured output",
      secondaryText: `${Object.keys(input).length} fields`,
      details: [],
      showInputPreview: false,
      contentLabel: "Submitted fields",
      outputContent: {
        kind: "property-list",
        items: Object.entries(input).map(([label, value]) => ({ label, value })),
      },
    };
  }

  if (toolKey.startsWith("mcp__claude-in-chrome__")) {
    const action = toolKey.replace("mcp__claude-in-chrome__", "").replaceAll("_", " ");
    const url = toStringValue(input.url);
    const interaction = toStringValue(input.action) || toStringValue(input.query);
    const tabId = displayValue(input.tabId);
    return {
      ...defaultStrategy,
      Icon: PanelsTopLeft,
      title: `browser · ${action}`,
      secondaryText: url || interaction || undefined,
      details: tabId ? [{ label: "Tab", value: tabId }] : [],
      showInputPreview: false,
      contentLabel: "Browser result",
    };
  }

  if (toolKey === "sendmessage") {
    const recipient = toStringValue(input.recipient) || toStringValue(input.to);
    return {
      ...defaultStrategy,
      Icon: MessageSquareMore,
      title: "send message",
      secondaryText: recipient || undefined,
      details: [],
      showInputPreview: false,
      contentLabel: "Message details",
      outputContent: {
        kind: "property-list",
        items: buildSendMessageOutput(input, state),
      },
    };
  }

  return { ...defaultStrategy, title: getToolTitle(tool) };
}
