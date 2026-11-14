import { buildPiCodeExecutionStrategy } from "./pi-code-execution";
import { t } from "../../../i18n/translate";
/**
 * Pi tool display strategy — todo/read/write/edit/agent/bash rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "@codesesh/contract";
import type { ToolDetailItem } from "../codex-tool";
import { buildPiEditDiffBlocks } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import {
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildFileWriteStrategy,
  buildSearchToolStrategy,
  buildShellToolStrategy,
} from "./shared";
import { Bot, FilePlus2, Image as ImageIcon, ListTodo } from "../../ui/icons";

export function getPiTodoTaskFromDetails(state: NormalizedToolState) {
  const input = toRecord(state.inputValue);
  const details = toRecord(state.metadataValue);
  const rawTasks = Array.isArray(details.tasks) ? details.tasks : [];
  const inputId = Number(input.id);
  const target =
    Number.isFinite(inputId) && inputId > 0
      ? rawTasks.find((task) => Number(toRecord(task).id) === inputId)
      : rawTasks.at(-1);
  return toRecord(target);
}

export function getPiTodoStatusChange(state: NormalizedToolState) {
  const text = getOutputOrErrorText(state);
  const match = text.match(/\(([^()]+?)\s*→\s*([^()]+?)\)/);
  if (!match) return "";
  return `${match[1]} -> ${match[2]}`;
}

export function buildPiSubagentResultDetails(text: string): ToolDetailItem[] {
  const firstLine = text.split("\n")[0] ?? "";
  const agentMatch = firstLine.match(/^Agent:\s*(.+)$/i);
  const summaryLine = text.split("\n").find((line) => line.includes(t("Status:")));
  const details: ToolDetailItem[] = [];
  if (agentMatch?.[1]) details.push({ label: t("Agent"), value: agentMatch[1].trim() });
  if (summaryLine) details.push({ label: t("Summary"), value: summaryLine.trim() });
  return details;
}

export function buildPiToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = tool.tool.toLowerCase();
  const input = toRecord(state.inputValue);
  const metadata = toRecord(state.metadataValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "codemode") return buildPiCodeExecutionStrategy(tool, state);

  if (toolKey === "todo") {
    const action = toPlainText(input.action) || toPlainText(metadata.action) || "todo";
    const task = getPiTodoTaskFromDetails(state);
    const taskId = Number(task.id) || Number(input.id);
    const subject = toPlainText(task.subject) || toPlainText(input.subject);
    const description = toPlainText(task.description) || toPlainText(input.description);
    const status = toPlainText(task.status) || toPlainText(input.status);
    const statusChange = getPiTodoStatusChange(state);
    const secondaryParts = [
      taskId ? `#${taskId}` : "",
      subject,
      action === "update" && statusChange ? statusChange : status,
    ].filter(Boolean);

    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title:
        action === "create" ? t("todo create") : action === "update" ? t("todo update") : "todo",
      secondaryText: secondaryParts.join(" · ") || undefined,
      details: [
        taskId ? { label: "ID", value: `#${taskId}` } : null,
        subject ? { label: t("Subject"), value: subject } : null,
        status ? { label: t("Status"), value: status } : null,
        statusChange ? { label: t("Change"), value: statusChange } : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: description || getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "read") {
    return buildFileReadStrategy({ defaultStrategy, state, filePath, displayPath });
  }

  if (toolKey === "write") {
    return buildFileWriteStrategy({
      defaultStrategy,
      state: { ...state, inputValue: { ...input, content: input.content ?? input.contents } },
      filePath,
      displayPath,
      Icon: FilePlus2,
    });
  }

  if (toolKey === "edit" || toolKey === "strreplace") {
    const diffBlocks =
      state.status === "completed" ? buildPiEditDiffBlocks(state, displayPath || filePath) : [];
    const firstChangedLine =
      typeof metadata.firstChangedLine === "number"
        ? String(metadata.firstChangedLine)
        : toStringValue(metadata.firstChangedLine);
    return buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      details: firstChangedLine ? [{ label: t("Line"), value: firstChangedLine }] : [],
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
    });
  }

  if (toolKey === "agent") {
    const description = toPlainText(input.description) || toPlainText(metadata.description);
    const subagentType = toPlainText(input.subagent_type) || toPlainText(metadata.subagentType);
    const agentId = toPlainText(metadata.agentId);
    const status = toPlainText(metadata.status);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: subagentType ? t("agent · {0}", [subagentType]) : "agent",
      secondaryText: [agentId ? `#${agentId}` : "", description, status]
        .filter(Boolean)
        .join(" · "),
      details: [
        agentId ? { label: t("Agent"), value: agentId } : null,
        subagentType ? { label: t("Type"), value: subagentType } : null,
        status ? { label: t("Task state"), value: status } : null,
        input.run_in_background === true ? { label: t("Mode"), value: t("Background") } : null,
        toStringValue(input.prompt)
          ? { label: t("Request"), value: toStringValue(input.prompt) }
          : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "get_subagent_result") {
    const agentId = toPlainText(input.agent_id);
    const outputText = getOutputOrErrorText(state);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: t("subagent result"),
      secondaryText: agentId ? `#${agentId}` : undefined,
      details: buildPiSubagentResultDetails(outputText),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: outputText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "analyze_image") {
    const images = Array.isArray(input.images)
      ? input.images.map((image) => toStringValue(image)).filter(Boolean)
      : [];
    const question = toStringValue(input.question);
    return {
      ...defaultStrategy,
      Icon: ImageIcon,
      title: t("analyze image"),
      secondaryText: images.map((image) => getDisplayPath(image, baseDirectory)).join(", "),
      details: [
        ...images.map((image, index) => ({
          label: index === 0 ? t("Image") : t("Image {0}", [index + 1]),
          value: getDisplayPath(image, baseDirectory),
        })),
        question ? { label: t("Question"), value: question } : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "grep" || toolKey === "glob" || toolKey === "ls") {
    const strategy = buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: tool.tool,
      path: toPlainText(input.path) || toPlainText(input.target_directory),
      pattern:
        toPlainText(input.pattern) || toPlainText(input.glob_pattern) || toPlainText(input.glob),
      baseDirectory,
    });
    return {
      ...strategy,
      showInputPreview:
        toolKey === "grep" && Object.keys(input).some((key) => key !== "path" && key !== "pattern"),
    };
  }

  if (toolKey === "bash" || toolKey === "batch" || toolKey === "shell") {
    const truncation = toRecord(metadata.truncation);
    const truncated = metadata.truncated === true || truncation.truncated === true;
    const fullOutputPath = toStringValue(metadata.fullOutputPath);
    const exitCode = metadata.exitCode;
    return {
      ...buildShellToolStrategy({
        defaultStrategy,
        state,
        title: tool.tool,
        command: toStringValue(input.command),
        description: toPlainText(input.description),
        baseDirectory,
      }),
      showInputPreview: Object.keys(input).some(
        (key) => key !== "command" && key !== "description",
      ),
      details: [
        typeof exitCode === "number" || typeof exitCode === "string"
          ? { label: t("Exit code"), value: String(exitCode) }
          : null,
        metadata.cancelled === true ? { label: t("Status"), value: t("Cancelled") } : null,
        truncated ? { label: t("Output"), value: t("Truncated") } : null,
        typeof truncation.outputLines === "number" && typeof truncation.totalLines === "number"
          ? { label: t("Lines"), value: `${truncation.outputLines} / ${truncation.totalLines}` }
          : null,
        typeof truncation.outputBytes === "number" && typeof truncation.totalBytes === "number"
          ? {
              label: t("Size"),
              value: t("{0} bytes", [`${truncation.outputBytes} / ${truncation.totalBytes}`]),
            }
          : null,
        fullOutputPath ? { label: t("Full output"), value: fullOutputPath } : null,
      ].filter((item): item is ToolDetailItem => item != null),
    };
  }

  return defaultStrategy;
}
