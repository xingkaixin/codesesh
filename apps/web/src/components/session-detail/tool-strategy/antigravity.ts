import { createPatch } from "diff";
import type { ToolPart } from "@codesesh/contract";
import { t } from "../../../i18n/translate";
import { detectLanguageByFilePath } from "../../tool-output/language";
import type {
  FileSectionItem,
  PropertyItem,
  QuestionListItem,
  TaskListItem,
  ToolOutputContent,
} from "../../tool-output/types";
import {
  Bot,
  CalendarRange,
  CheckCircle2,
  CircleHelp,
  Clock3,
  FileSearch,
  Folder,
  Globe,
  Image as ImageIcon,
  ListTodo,
  MessageSquareMore,
  NotebookPen,
  PanelsTopLeft,
  Plug,
  SquareTerminal,
  Users,
  Wrench,
} from "../../ui/icons";
import type { ToolDetailItem } from "../codex-tool";
import { buildStructuredDiffFromTexts } from "../diff";
import { getDisplayPath, getDisplayTextWithRelativePaths } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStrategyOptions,
  buildSemanticOutputContent,
  compactText,
  getOutputOrErrorText,
  parseInputCandidate,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import {
  EMPTY_TOOL_OUTPUT,
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildSearchToolStrategy,
  buildShellToolStrategy,
} from "./shared";

const TRUNCATION_BANNER =
  /^The tool's output was truncated due to being too long\. You can find the full output in a file at ([^\n]+?)\.\r?\n+(?:Here is a preview[^\n]*:\r?\n)?/;
const TIMESTAMP_HEADER = /^Created At: [^\n]*\r?\nCompleted At: [^\n]*\r?\n?/;
const FILE_URI_PREFIX = /^file:\/\//i;
const SUMMARY_KEYS = [
  "toolSummary",
  "toolAction",
  "title",
  "summary",
  "query",
  "url",
  "path",
  "Path",
  "key",
  "number",
  "threadId",
  "taskId",
  "tabId",
  "repository",
  "branch",
  "name",
  "action",
  "Action",
];

interface UnwrappedOutput {
  text: string;
  fullOutputPath?: string;
}

function stripFileUri(value: string) {
  return value.trim().replace(FILE_URI_PREFIX, "");
}

function unwrapOutput(raw: string): UnwrappedOutput {
  let text = raw;
  let fullOutputPath: string | undefined;
  const truncation = TRUNCATION_BANNER.exec(text);
  if (truncation) {
    fullOutputPath = stripFileUri(truncation[1] ?? "");
    text = text.slice(truncation[0].length);
  }
  text = text.replace(TIMESTAMP_HEADER, "");
  return { text, fullOutputPath };
}

function plainTextContent(text: string, language = "text", isCode = false): ToolOutputContent {
  return { kind: "plain", text, language, isCode };
}

function detail(label: string, value: string | undefined): ToolDetailItem | null {
  const trimmed = value?.trim();
  return trimmed ? { label, value: trimmed } : null;
}

function compactDetails(items: Array<ToolDetailItem | null | undefined>): ToolDetailItem[] {
  return items.filter((item): item is ToolDetailItem => item != null);
}

function hasUnrenderedKeys(record: Record<string, unknown>, renderedKeys: ReadonlySet<string>) {
  for (const [key, value] of Object.entries(record)) {
    if (renderedKeys.has(key)) continue;
    if (value == null || value === "") continue;
    return true;
  }
  return false;
}

function humanizeName(value: string) {
  return value.replace(/^_+/, "").replaceAll("_", " ");
}

function formatDuration(seconds: unknown) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

function firstLine(text: string, maxLength = 96) {
  const line =
    text
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}

function formatDetailScalar(value: unknown, baseDirectory?: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/") || trimmed.startsWith("file://")) {
      return getDisplayPath(stripFileUri(trimmed), baseDirectory);
    }
    return getDisplayTextWithRelativePaths(trimmed, baseDirectory);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v !== "object")) {
    return value.map((v) => formatDetailScalar(v, baseDirectory)).join(", ");
  }
  return "";
}

function extractMcpTool(toolName: string, input: Record<string, unknown>) {
  if (toolName === "call_mcp_tool") {
    const server = toPlainText(input.ServerName);
    const operation = toPlainText(input.ToolName);
    if (!server && !operation) return null;
    const toolSummary = toPlainText(input.toolSummary);
    const toolAction = toPlainText(input.toolAction);
    const renderedOuterKeys = new Set([
      "ServerName",
      "ToolName",
      "Arguments",
      ...(toolSummary ? ["toolSummary"] : toolAction ? ["toolAction"] : []),
    ]);
    return {
      server: server || "mcp",
      operation: operation || "tool",
      args: toRecord(input.Arguments),
      summary: toolSummary || toolAction,
      renderedArgSummaryKey: "",
      hasOuterUnrendered: hasUnrenderedKeys(input, renderedOuterKeys),
    };
  }
  const match = /^mcp_([^_]+)_(.+)$/.exec(toolName);
  if (!match) return null;
  const toolSummary = toPlainText(input.toolSummary);
  const toolAction = toPlainText(input.toolAction);
  return {
    server: match[1] ?? "mcp",
    operation: match[2] ?? "tool",
    args: input,
    summary: toolSummary || toolAction,
    renderedArgSummaryKey: toolSummary ? "toolSummary" : toolAction ? "toolAction" : "",
    hasOuterUnrendered: false,
  };
}

function firstSummaryValue(input: Record<string, unknown>, baseDirectory?: string) {
  for (const key of SUMMARY_KEYS) {
    const formatted = formatDetailScalar(input[key], baseDirectory);
    if (!formatted) continue;
    const oneLine = compactText(formatted);
    return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
  }
  return "";
}

function buildMcpArgDetails(
  args: Record<string, unknown>,
  renderedSummaryKey: string,
  baseDirectory?: string,
) {
  const details: ToolDetailItem[] = [];
  let hasOmittedArgs = false;
  for (const [key, value] of Object.entries(args)) {
    if (key === renderedSummaryKey) continue;
    if (value == null || value === "") continue;
    const formatted = formatDetailScalar(value, baseDirectory);
    if (!formatted || details.length >= 6) {
      hasOmittedArgs = true;
      continue;
    }
    details.push({ label: humanizeName(key), value: formatted });
  }
  return { details, hasOmittedArgs };
}

function parseReadOutput(body: string, input: Record<string, unknown>) {
  let content = body;
  let lineRange = "";
  let numbered = false;

  const showingMatch = /^Showing lines (\d+-\d+) of (\d+)\r?\n?/.exec(content);
  if (showingMatch) {
    lineRange = `${showingMatch[1]} / ${showingMatch[2]}`;
    content = content.slice(showingMatch[0].length);
    numbered = true;
  } else {
    const partialMatch = /^Partial read \(lines (\d+-\d+) of (\d+)\)\.[^\n]*\r?\n?/.exec(content);
    if (partialMatch) {
      lineRange = `${partialMatch[1]} / ${partialMatch[2]}`;
      content = content.slice(partialMatch[0].length);
      numbered = true;
    } else {
      const legacyMatch =
        /^File Path: [^\n]*\r?\nTotal Lines: (\d+)\r?\nTotal Bytes: \d+\r?\nShowing lines (\d+) to (\d+)\r?\n(?:The following code has been modified[^\n]*\r?\n)?/.exec(
          content,
        );
      if (legacyMatch) {
        lineRange = `${legacyMatch[2]}-${legacyMatch[3]} / ${legacyMatch[1]}`;
        content = content.slice(legacyMatch[0].length);
        numbered = true;
      }
    }
  }

  if (!lineRange && (typeof input.StartLine === "number" || typeof input.EndLine === "number")) {
    const start = typeof input.StartLine === "number" ? input.StartLine : 1;
    const end = typeof input.EndLine === "number" ? input.EndLine : "∞";
    lineRange = `${start}-${end}`;
  }

  const isBinaryOrEmpty =
    /^Showing binary file of type /i.test(content.trim()) ||
    /^File is empty\.?$/i.test(content.trim());

  if (numbered && !isBinaryOrEmpty) {
    content = content
      .split("\n")
      .map((line) => line.replace(/^\d+:\s?/, ""))
      .join("\n")
      .trimEnd();
  }

  return { content, lineRange, isBinaryOrEmpty };
}

function parseCommandOutput(body: string) {
  let text = body;
  let exitCode = "";
  const exitMatch = /^Command exited with code (-?\d+)\.\r?\n?/.exec(text);
  if (exitMatch) {
    exitCode = exitMatch[1] ?? "";
    text = text.slice(exitMatch[0].length);
  }
  text = text.replace(/^\r?\n*Command output:\r?\n?/, "");
  return { text, exitCode };
}

function summarizeSteps(rawSteps: unknown[]) {
  const counts = new Map<string, number>();
  const items: TaskListItem[] = rawSteps.map((value) => {
    const step = toRecord(value);
    const rawStatus = toPlainText(step.status);
    let status: TaskListItem["status"] = "pending";
    if (rawStatus === "done" || rawStatus === "completed") status = "completed";
    else if (rawStatus === "in_progress") status = "in_progress";
    else if (rawStatus === "failed" || rawStatus === "error") status = "error";
    const bucket = rawStatus === "skipped" ? "skipped" : status;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    return {
      label: toPlainText(step.title) || t("Untitled task"),
      status,
      detail: rawStatus === "skipped" ? "skipped" : undefined,
    };
  });
  const summary = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · ");
  return { items, summary };
}

function normalizeRecommendedOption(raw: string) {
  const trimmed = raw.trim();
  const label = trimmed
    .replace(/^\(Recommended\)\s*/i, "")
    .replace(/\s*\(Recommended\)$/i, "")
    .trim();
  return { label: label || trimmed, recommended: label !== trimmed || undefined };
}

function parseAskQuestionAnswers(body: string) {
  const answers = new Map<number, string>();
  const matches = [...body.matchAll(/^A(\d+):\s*/gm)];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current || current.index === undefined) continue;
    const num = Number(current[1]);
    const start = current.index + current[0].length;
    const end = matches[i + 1]?.index ?? body.length;
    const value = body.slice(start, end).trim();
    if (value) answers.set(num, value);
  }
  return answers;
}

function buildAskQuestionItems(rawQuestions: unknown[], answerBody: string): QuestionListItem[] {
  const answerMap = parseAskQuestionAnswers(answerBody);
  return rawQuestions.flatMap((value, index) => {
    const record = toRecord(value);
    const question = toPlainText(record.question);
    if (!question) return [];
    const options = (Array.isArray(record.options) ? record.options : []).flatMap((opt) => {
      const text = typeof opt === "string" ? opt : toPlainText(toRecord(opt).label);
      if (!text.trim()) return [];
      const normalized = normalizeRecommendedOption(text);
      return [
        {
          label: normalized.label,
          recommended: normalized.recommended,
        },
      ];
    });
    const rawAnswer = answerMap.get(index + 1) ?? "";
    const optionLabels = new Set(options.map((opt) => opt.label));
    let answers: string[] = [];
    if (rawAnswer) {
      if (record.is_multi_select === true) {
        answers = rawAnswer
          .split(/,\s*/)
          .map((part) => normalizeRecommendedOption(part).label)
          .filter(Boolean);
      } else {
        const normalized = normalizeRecommendedOption(rawAnswer).label;
        answers = [optionLabels.has(normalized) ? normalized : rawAnswer];
      }
    }
    return [
      {
        question,
        options,
        answers,
        unansweredLabel: t("No answer recorded"),
      },
    ];
  });
}

function extractLeadingJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return parseInputCandidate(text.slice(start, i + 1));
      }
    }
  }
  return null;
}

function parseManageTaskOutput(body: string, baseDirectory?: string) {
  const lines = body.split(/\r?\n/);
  const details: ToolDetailItem[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = /^(Task|Status|Log):\s*(.+)$/.exec(line);
    if (!match) break;
    const key = match[1];
    const value = match[2] ?? "";
    if (key === "Status") details.push({ label: t("Status"), value });
    else if (key === "Log") {
      details.push({ label: t("Log"), value: getDisplayPath(stripFileUri(value), baseDirectory) });
    }
    index++;
  }
  if (/^Log output:\s*$/i.test(lines[index] ?? "")) index++;
  const output = lines.slice(index).join("\n").trim();
  return { details, output: output || body };
}

const READ_KEYS = new Set(["Path", "AbsolutePath", "StartLine", "EndLine", "ByteOffset"]);
const RUN_COMMAND_KEYS = new Set(["CommandLine", "Cwd", "toolSummary"]);
const WRITE_KEYS = new Set(["Path", "TargetFile", "Content", "CodeContent"]);
const WRITE_APPEND_KEYS = new Set(["Path", "TargetFile", "Content", "CodeContent", "Append"]);
const EDIT_KEYS = new Set([
  "Path",
  "TargetFile",
  "Target",
  "TargetContent",
  "Replacement",
  "ReplacementContent",
]);
const UPDATE_STEPS_KEYS = new Set(["steps"]);
const ASK_QUESTION_KEYS = new Set(["questions"]);
const INVOKE_SUBAGENT_KEYS = new Set(["Role", "TypeName", "Model", "Workspace", "Prompt"]);
const MANAGE_SUBAGENTS_KEYS = new Set(["Action", "ConversationIds"]);
const SWARM_KEYS = new Set(["action", "name", "title", "model", "workspace", "brief"]);
const SINCE_KEYS = new Set(["since"]);
const POST_MESSAGE_KEYS = new Set(["text"]);
const SEND_MESSAGE_KEYS = new Set(["Recipient", "Message"]);
const MANAGE_TASK_KEYS = new Set(["Action", "TaskId", "Input"]);
const SCHEDULE_KEYS = new Set(["DurationSeconds", "CronExpression", "TimerCondition", "Prompt"]);
const SEARCH_WEB_KEYS = new Set(["query", "domain"]);
const READ_URL_KEYS = new Set(["Url"]);
const SEARCH_KEYS = new Set(["SearchPath", "SearchDirectory", "DirectoryPath", "Query", "Pattern"]);
const WEBVIEW_BROWSER_KEYS = new Set(["intention", "observation", "script"]);
const ENTER_PLAN_KEYS = new Set(["reason"]);
const EXIT_PLAN_KEYS = new Set(["plan"]);
const GENERATE_IMAGE_KEYS = new Set(["ImageName", "AspectRatio", "ImagePaths", "Prompt"]);
const RUN_WORKFLOW_KEYS = new Set(["Description", "ScriptPath", "Script", "Cwd"]);
const FINISH_KEYS = new Set(["result"]);

export function buildAntigravityToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
  options?: ToolStrategyOptions,
): ToolDisplayStrategy {
  const includeOutput = options?.includeOutput ?? true;
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory, options);
  const input = toRecord(state.inputValue);
  const filePath =
    toPlainText(input.Path) || toPlainText(input.AbsolutePath) || toPlainText(input.TargetFile);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  const getUnwrapped = () => unwrapOutput(toStringValue(state.outputValue));
  const getFullOutputDetail = (unwrapped: UnwrappedOutput) =>
    unwrapped.fullOutputPath
      ? detail(t("Full output"), getDisplayPath(unwrapped.fullOutputPath, baseDirectory))
      : null;

  const getResultText = (unwrapped = getUnwrapped()) => {
    const combined = [
      ...new Set([toStringValue(state.errorValue), unwrapped.text.trim() ? unwrapped.text : ""]),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (combined) return combined;
    if (typeof state.outputValue === "string") return t("No output captured.");
    return getOutputOrErrorText(state);
  };
  const getResultContent = (unwrapped?: UnwrappedOutput) =>
    plainTextContent(getResultText(unwrapped));
  const getSemanticOrPlain = (text?: string): ToolOutputContent => {
    const unwrapped = text !== undefined ? { text } : getUnwrapped();
    if (state.status === "error") return getResultContent(unwrapped);
    return (
      buildSemanticOutputContent(unwrapped.text) ??
      plainTextContent(unwrapped.text || getResultText(unwrapped))
    );
  };

  switch (tool.tool) {
    case "read_file":
    case "view_file": {
      const showInputPreview = hasUnrenderedKeys(input, READ_KEYS);
      if (!includeOutput) {
        return {
          ...buildFileReadStrategy({
            defaultStrategy,
            state,
            filePath,
            displayPath,
            includeOutput: false,
          }),
          showInputPreview,
        };
      }
      const unwrapped = getUnwrapped();
      const parsed = parseReadOutput(unwrapped.text, input);
      const readDetails = compactDetails([
        detail(t("Lines"), parsed.lineRange),
        detail(
          t("Offset"),
          typeof input.ByteOffset === "number" ? String(input.ByteOffset) : undefined,
        ),
        getFullOutputDetail(unwrapped),
      ]);
      const read = buildFileReadStrategy({
        defaultStrategy,
        state,
        filePath,
        displayPath,
        details: readDetails,
        text: () =>
          state.status === "error"
            ? getResultText(unwrapped)
            : parsed.content || getResultText(unwrapped),
        isCode: state.status !== "error" && !parsed.isBinaryOrEmpty,
        includeOutput: true,
      });
      return {
        ...read,
        showInputPreview,
        outputContent:
          state.status === "error"
            ? getResultContent(unwrapped)
            : parsed.isBinaryOrEmpty
              ? plainTextContent(parsed.content)
              : read.outputContent,
      };
    }

    case "run_command": {
      const shell = buildShellToolStrategy({
        defaultStrategy,
        state,
        title: tool.tool,
        command: toStringValue(input.CommandLine),
        description: toPlainText(input.toolSummary) || undefined,
        baseDirectory,
        includeCommandDetail: true,
        includeOutput: false,
      });
      const showInputPreview = hasUnrenderedKeys(input, RUN_COMMAND_KEYS);
      if (!includeOutput) {
        return {
          ...shell,
          contentLabel: state.status === "error" ? t("Error") : t("Terminal output"),
          showInputPreview,
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const parsed = parseCommandOutput(unwrapped.text);
      const cwd = getDisplayPath(toPlainText(input.Cwd), baseDirectory);
      const outputText =
        state.status === "error"
          ? [...new Set([toStringValue(state.errorValue), parsed.text])]
              .filter(Boolean)
              .join("\n\n") || getResultText(unwrapped)
          : parsed.text;
      return {
        ...shell,
        details: compactDetails([
          ...shell.details,
          detail(t("Workdir"), cwd),
          detail(t("Exit code"), parsed.exitCode),
          getFullOutputDetail(unwrapped),
        ]),
        contentLabel: state.status === "error" ? t("Error") : t("Terminal output"),
        showInputPreview,
        outputContent: plainTextContent(outputText),
      };
    }

    case "write_file":
    case "write_to_file":
    case "edit_file":
    case "replace_file_content": {
      const isWrite = tool.tool === "write_file" || tool.tool === "write_to_file";
      const operation = isWrite ? "write" : "edit";
      const writeRenderedKeys = input.Append === true ? WRITE_APPEND_KEYS : WRITE_KEYS;
      const showInputPreview = hasUnrenderedKeys(input, isWrite ? writeRenderedKeys : EDIT_KEYS);
      if (!includeOutput) {
        const collapsed = buildFileEditStrategy({
          defaultStrategy,
          displayPath,
          includeOutput: false,
          outputContent: EMPTY_TOOL_OUTPUT,
        });
        return {
          ...collapsed,
          ...(isWrite ? { Icon: NotebookPen, title: "write" } : {}),
          showInputPreview,
        };
      }

      const content = input.Content ?? input.CodeContent;
      const target = input.Target ?? input.TargetContent;
      const replacement = input.Replacement ?? input.ReplacementContent;
      const unwrapped = getUnwrapped();
      const hasNativeOutput = unwrapped.text.trim().length > 0;
      const summaryLine = getDisplayTextWithRelativePaths(
        firstLine(unwrapped.text, 160),
        baseDirectory,
      );

      if (state.status === "completed" && hasNativeOutput) {
        if (isWrite && typeof content === "string") {
          return {
            ...defaultStrategy,
            Icon: NotebookPen,
            title: "write",
            secondaryText: displayPath || undefined,
            details: compactDetails([
              detail(t("Result"), summaryLine),
              input.Append === true ? detail(t("Append"), t("Yes")) : null,
            ]),
            showInputPreview,
            outputContent: plainTextContent(content, detectLanguageByFilePath(filePath), true),
            rawOutput: state.outputValue || undefined,
          };
        }
        if (!isWrite && typeof target === "string" && typeof replacement === "string") {
          const blocks = buildStructuredDiffFromTexts(displayPath || filePath, target, replacement);
          if (blocks.length > 0) {
            return {
              ...buildFileEditStrategy({
                defaultStrategy,
                displayPath,
                details: compactDetails([detail(t("Result"), summaryLine)]),
                includeOutput: true,
                outputContent: { kind: "structured-diff", blocks },
              }),
              showInputPreview,
              rawOutput: state.outputValue || undefined,
            };
          }
        }
      }

      const sections: FileSectionItem[] = [
        {
          label: t("Result"),
          operation,
          language: "text",
          isCode: false,
          text: getResultText(unwrapped),
        },
      ];
      if (isWrite && typeof content === "string") {
        sections.push({
          label: t("Requested content"),
          operation,
          language: detectLanguageByFilePath(filePath),
          isCode: true,
          text: content,
        });
      } else if (!isWrite && typeof target === "string" && typeof replacement === "string") {
        sections.push({
          label: t("Requested changes"),
          operation,
          language: "diff",
          isCode: true,
          text: createPatch(displayPath || filePath, target, replacement),
        });
      }
      const edit = buildFileEditStrategy({
        defaultStrategy,
        displayPath,
        details:
          isWrite && input.Append === true
            ? compactDetails([detail(t("Append"), t("Yes"))])
            : undefined,
        includeOutput: true,
        outputContent: { kind: "file-sections", sections },
      });
      return {
        ...edit,
        ...(isWrite ? { Icon: NotebookPen, title: "write" } : {}),
        showInputPreview,
      };
    }

    case "update_steps": {
      const rawSteps = Array.isArray(input.steps) ? input.steps : [];
      const summarized = summarizeSteps(rawSteps);
      const isError = state.status === "error";
      const rendersTaskList = !isError && summarized.items.length > 0;
      return {
        ...defaultStrategy,
        Icon: ListTodo,
        title: t("update plan"),
        secondaryText: summarized.summary || undefined,
        details: [],
        showInputPreview: !rendersTaskList || hasUnrenderedKeys(input, UPDATE_STEPS_KEYS),
        contentLabel: isError ? t("Error") : t("Plan"),
        outputContent: !includeOutput
          ? EMPTY_TOOL_OUTPUT
          : rendersTaskList
            ? { kind: "task-list", items: summarized.items }
            : getResultContent(),
      };
    }

    case "ask_question": {
      const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
      const isError = state.status === "error";
      const showInputPreview = isError || hasUnrenderedKeys(input, ASK_QUESTION_KEYS);
      if (!includeOutput) {
        const count = rawQuestions.filter((q) => Boolean(toPlainText(toRecord(q).question))).length;
        return {
          ...defaultStrategy,
          Icon: CircleHelp,
          title: t("ask user"),
          secondaryText: count ? t("{0} question{1}", [count, count === 1 ? "" : "s"]) : undefined,
          details: [],
          showInputPreview,
          contentLabel: isError ? t("Error") : t("Questions"),
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      if (isError) {
        return {
          ...defaultStrategy,
          Icon: CircleHelp,
          title: t("ask user"),
          secondaryText: rawQuestions.length
            ? t("{0} question{1}", [rawQuestions.length, rawQuestions.length === 1 ? "" : "s"])
            : undefined,
          details: [],
          showInputPreview: true,
          contentLabel: t("Error"),
          outputContent: getResultContent(unwrapped),
        };
      }
      const questions = buildAskQuestionItems(rawQuestions, unwrapped.text);
      return {
        ...defaultStrategy,
        Icon: CircleHelp,
        title: t("ask user"),
        secondaryText: questions.length
          ? t("{0} question{1}", [questions.length, questions.length === 1 ? "" : "s"])
          : undefined,
        details: [],
        showInputPreview,
        contentLabel: t("Questions"),
        outputContent:
          questions.length > 0 ? { kind: "question-list", questions } : getResultContent(unwrapped),
      };
    }

    case "invoke_subagent": {
      const typeName = toPlainText(input.TypeName);
      const role = toPlainText(input.Role);
      const showInputPreview = hasUnrenderedKeys(input, INVOKE_SUBAGENT_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: Bot,
          title: typeName ? t("agent · {0}", [typeName]) : "subagent",
          secondaryText: role || undefined,
          details: [],
          contentLabel: t("Agent result"),
          showInputPreview,
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const parsed = state.status === "error" ? null : extractLeadingJsonObject(unwrapped.text);
      const semantic = parsed ? buildSemanticOutputContent(parsed) : null;
      return {
        ...defaultStrategy,
        Icon: Bot,
        title: typeName ? t("agent · {0}", [typeName]) : "subagent",
        secondaryText: role || undefined,
        details: compactDetails([
          detail(t("Model"), toPlainText(input.Model)),
          detail(t("Workspace"), toPlainText(input.Workspace)),
          detail(t("Prompt"), toStringValue(input.Prompt)),
        ]),
        contentLabel: t("Agent result"),
        showInputPreview,
        outputContent: semantic ?? getResultContent(unwrapped),
        rawOutput: semantic ? state.outputValue || undefined : undefined,
      };
    }

    case "manage_subagents": {
      const action = toPlainText(input.Action);
      const ids = Array.isArray(input.ConversationIds)
        ? input.ConversationIds.map(toPlainText).filter(Boolean).join(", ")
        : "";
      const showInputPreview = hasUnrenderedKeys(input, MANAGE_SUBAGENTS_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: Users,
          title: ["subagents", action].filter(Boolean).join(" · "),
          secondaryText: ids || undefined,
          details: [],
          showInputPreview,
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const outputContent =
        state.status === "error"
          ? getResultContent(unwrapped)
          : (() => {
              const arrayStart = unwrapped.text.indexOf("[");
              const parsed =
                arrayStart !== -1 ? parseInputCandidate(unwrapped.text.slice(arrayStart)) : null;
              if (Array.isArray(parsed) && parsed.length > 0) {
                const items: PropertyItem[] = parsed.map((entry, idx) => {
                  const rec = toRecord(entry);
                  const label =
                    toPlainText(rec.role) || toPlainText(rec.conversationId) || `#${idx + 1}`;
                  return { label, value: entry };
                });
                return { kind: "property-list" as const, items };
              }
              return getResultContent(unwrapped);
            })();
      return {
        ...defaultStrategy,
        Icon: Users,
        title: ["subagents", action].filter(Boolean).join(" · "),
        secondaryText: ids || undefined,
        details: [],
        showInputPreview,
        outputContent,
      };
    }

    case "swarm": {
      const action = toPlainText(input.action);
      return {
        ...defaultStrategy,
        Icon: Bot,
        title: [tool.tool, action].filter(Boolean).join(" · "),
        secondaryText: toPlainText(input.name) || toPlainText(input.title) || undefined,
        details: includeOutput
          ? compactDetails([
              detail(t("Model"), toPlainText(input.model)),
              detail(t("Workspace"), toPlainText(input.workspace)),
              detail(t("Brief"), toStringValue(input.brief)),
            ])
          : [],
        showInputPreview: hasUnrenderedKeys(input, SWARM_KEYS),
        outputContent: includeOutput ? getSemanticOrPlain() : EMPTY_TOOL_OUTPUT,
      };
    }

    case "read_board": {
      const since = typeof input.since === "number" ? `since #${input.since}` : "";
      const showInputPreview = hasUnrenderedKeys(input, SINCE_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: MessageSquareMore,
          title: t("read board"),
          secondaryText: since || undefined,
          details: [],
          showInputPreview,
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const parsed = toRecord(parseInputCandidate(unwrapped.text));
      const boardMessages = Array.isArray(parsed.messages) ? parsed.messages : null;
      const countText = boardMessages ? t("{0} messages", [boardMessages.length]) : "";
      const outputContent =
        state.status !== "error" && boardMessages && boardMessages.length > 0
          ? {
              kind: "property-list" as const,
              items: boardMessages.map((entry, idx) => {
                const msg = toRecord(entry);
                const seq = typeof msg.seq === "number" ? `#${msg.seq}` : `#${idx + 1}`;
                const agent = toPlainText(msg.agent);
                return {
                  label: [seq, agent].filter(Boolean).join(" · "),
                  value: toStringValue(msg.text) || entry,
                };
              }),
            }
          : getSemanticOrPlain(unwrapped.text);
      return {
        ...defaultStrategy,
        Icon: MessageSquareMore,
        title: t("read board"),
        secondaryText: [since, countText].filter(Boolean).join(" · ") || undefined,
        details: compactDetails([getFullOutputDetail(unwrapped)]),
        showInputPreview,
        outputContent,
      };
    }

    case "post_message": {
      const text = toStringValue(input.text);
      const showInputPreview =
        state.status === "error" || hasUnrenderedKeys(input, POST_MESSAGE_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: MessageSquareMore,
          title: t("post message"),
          secondaryText: firstLine(text, 96) || undefined,
          details: [],
          showInputPreview,
          contentLabel: t("Message details"),
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const parsed = toRecord(parseInputCandidate(unwrapped.text));
      const delivery =
        typeof parsed.seq === "number"
          ? `${toPlainText(parsed.status) || "posted"} (#${parsed.seq})`
          : unwrapped.text;
      const items: PropertyItem[] = [
        ...(text ? [{ label: t("Message"), value: text }] : []),
        ...(delivery ? [{ label: t("Delivery"), value: delivery }] : []),
      ];
      return {
        ...defaultStrategy,
        Icon: MessageSquareMore,
        title: t("post message"),
        secondaryText: firstLine(text, 96) || undefined,
        details: [],
        showInputPreview,
        contentLabel: t("Message details"),
        outputContent:
          state.status !== "error" && items.length > 0
            ? { kind: "property-list", items }
            : getResultContent(unwrapped),
      };
    }

    case "swarm_wait": {
      const since = typeof input.since === "number" ? `since #${input.since}` : undefined;
      const unwrapped = includeOutput ? getUnwrapped() : null;
      return {
        ...defaultStrategy,
        Icon: Clock3,
        title: t("swarm wait"),
        secondaryText: since,
        details: unwrapped ? compactDetails([getFullOutputDetail(unwrapped)]) : [],
        showInputPreview: hasUnrenderedKeys(input, SINCE_KEYS),
        outputContent: unwrapped ? getSemanticOrPlain(unwrapped.text) : EMPTY_TOOL_OUTPUT,
      };
    }

    case "send_message": {
      const recipient = toPlainText(input.Recipient);
      const showInputPreview = hasUnrenderedKeys(input, SEND_MESSAGE_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: MessageSquareMore,
          title: t("send message"),
          secondaryText: recipient || undefined,
          details: [],
          showInputPreview,
          contentLabel: t("Message details"),
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const message = toStringValue(input.Message);
      const delivery = state.status === "error" ? getResultText(unwrapped) : unwrapped.text;
      const items: PropertyItem[] = [
        ...(recipient ? [{ label: t("Recipient"), value: recipient }] : []),
        ...(message ? [{ label: t("Message"), value: message }] : []),
        ...(delivery ? [{ label: t("Delivery"), value: delivery }] : []),
      ];
      return {
        ...defaultStrategy,
        Icon: MessageSquareMore,
        title: t("send message"),
        secondaryText: recipient || undefined,
        details: [],
        showInputPreview,
        contentLabel: t("Message details"),
        outputContent:
          items.length > 0 ? { kind: "property-list", items } : getResultContent(unwrapped),
      };
    }

    case "manage_task": {
      const action = toPlainText(input.Action);
      const taskId = toPlainText(input.TaskId);
      const showInputPreview = hasUnrenderedKeys(input, MANAGE_TASK_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: SquareTerminal,
          title: ["task", action].filter(Boolean).join(" · "),
          secondaryText: taskId || undefined,
          details: [],
          contentLabel: state.status === "error" ? t("Error") : t("Terminal output"),
          showInputPreview,
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const parsed = parseManageTaskOutput(unwrapped.text, baseDirectory);
      return {
        ...defaultStrategy,
        Icon: SquareTerminal,
        title: ["task", action].filter(Boolean).join(" · "),
        secondaryText: taskId || undefined,
        details: compactDetails([
          detail(t("Input"), toStringValue(input.Input)),
          ...parsed.details,
          getFullOutputDetail(unwrapped),
        ]),
        contentLabel: state.status === "error" ? t("Error") : t("Terminal output"),
        showInputPreview,
        outputContent:
          state.status === "error" ? getResultContent(unwrapped) : plainTextContent(parsed.output),
      };
    }

    case "schedule": {
      const duration = formatDuration(input.DurationSeconds);
      const cron = toPlainText(input.CronExpression);
      const prompt = toStringValue(input.Prompt);
      const timing = duration || cron;
      return {
        ...defaultStrategy,
        Icon: Clock3,
        title: "schedule",
        secondaryText: [timing, firstLine(prompt, 80)].filter(Boolean).join(" · ") || undefined,
        details: includeOutput
          ? compactDetails([
              detail(t("Duration"), duration),
              detail(t("Cron"), cron),
              detail(t("Condition"), toPlainText(input.TimerCondition)),
              detail(t("Prompt"), prompt),
            ])
          : [],
        showInputPreview: hasUnrenderedKeys(input, SCHEDULE_KEYS),
        outputContent: includeOutput ? getResultContent() : EMPTY_TOOL_OUTPUT,
      };
    }

    case "search_web":
    case "read_url_content": {
      const isSearch = tool.tool === "search_web";
      const target = isSearch ? toPlainText(input.query) : toPlainText(input.Url);
      const unwrapped = includeOutput ? getUnwrapped() : null;
      return {
        ...defaultStrategy,
        Icon: Globe,
        title: isSearch ? t("web search") : t("web fetch"),
        secondaryText: target || undefined,
        details: unwrapped
          ? compactDetails([
              detail(t("Domain"), toPlainText(input.domain)),
              getFullOutputDetail(unwrapped),
            ])
          : [],
        contentLabel: t("Results"),
        showInputPreview: hasUnrenderedKeys(input, isSearch ? SEARCH_WEB_KEYS : READ_URL_KEYS),
        outputContent: unwrapped
          ? plainTextContent(getResultText(unwrapped), "markdown", false)
          : EMPTY_TOOL_OUTPUT,
      };
    }

    case "grep_search":
    case "find_by_name":
    case "list_dir": {
      const searchPath =
        toPlainText(input.SearchPath) ||
        toPlainText(input.SearchDirectory) ||
        toPlainText(input.DirectoryPath);
      const pattern = toPlainText(input.Query) || toPlainText(input.Pattern);
      const search = buildSearchToolStrategy({
        defaultStrategy,
        state,
        title: tool.tool,
        path: searchPath,
        pattern,
        baseDirectory,
        includeOutput: false,
      });
      const unwrapped = includeOutput ? getUnwrapped() : null;
      return {
        ...search,
        Icon: tool.tool === "list_dir" ? Folder : FileSearch,
        details: unwrapped ? compactDetails([getFullOutputDetail(unwrapped)]) : [],
        showInputPreview: hasUnrenderedKeys(input, SEARCH_KEYS),
        outputContent: unwrapped ? getResultContent(unwrapped) : EMPTY_TOOL_OUTPUT,
      };
    }

    case "webview_browser": {
      const showInputPreview = hasUnrenderedKeys(input, WEBVIEW_BROWSER_KEYS);
      if (!includeOutput) {
        return {
          ...defaultStrategy,
          Icon: PanelsTopLeft,
          title: t("Browser"),
          secondaryText: firstLine(toStringValue(input.intention), 100) || undefined,
          details: [],
          contentLabel: t("Browser result"),
          showInputPreview,
          outputContent: EMPTY_TOOL_OUTPUT,
        };
      }
      const unwrapped = getUnwrapped();
      const stepMatch = /^\[Browser Step (\d+)\]\r?\n/.exec(unwrapped.text);
      const stepNum = stepMatch?.[1];
      const payload = stepMatch ? unwrapped.text.slice(stepMatch[0].length) : unwrapped.text;
      return {
        ...defaultStrategy,
        Icon: PanelsTopLeft,
        title: t("Browser"),
        secondaryText: firstLine(toStringValue(input.intention), 100) || undefined,
        details: compactDetails([
          detail(t("Step"), stepNum),
          detail(t("Observation"), toStringValue(input.observation)),
          detail(t("Script"), toStringValue(input.script)),
          getFullOutputDetail(unwrapped),
        ]),
        contentLabel: t("Browser result"),
        showInputPreview,
        outputContent: getSemanticOrPlain(payload),
      };
    }

    case "enter_plan_mode":
    case "exit_plan_mode": {
      const isExit = tool.tool === "exit_plan_mode";
      const body = isExit ? toStringValue(input.plan) : toStringValue(input.reason);
      const unwrapped = includeOutput ? getUnwrapped() : null;
      return {
        ...defaultStrategy,
        Icon: CalendarRange,
        title: isExit ? t("exit plan") : t("plan mode"),
        secondaryText: firstLine(body, 96) || undefined,
        details: unwrapped
          ? compactDetails([detail(t("Result"), firstLine(unwrapped.text, 120))])
          : [],
        contentLabel: t("Plan"),
        showInputPreview: hasUnrenderedKeys(input, isExit ? EXIT_PLAN_KEYS : ENTER_PLAN_KEYS),
        outputContent: !unwrapped
          ? EMPTY_TOOL_OUTPUT
          : state.status === "error"
            ? getResultContent(unwrapped)
            : plainTextContent(body || getResultText(unwrapped), "markdown", false),
        rawOutput: unwrapped && body && unwrapped.text ? state.outputValue || undefined : undefined,
      };
    }

    case "generate_image": {
      const refs = Array.isArray(input.ImagePaths)
        ? input.ImagePaths.map((p) => getDisplayPath(toPlainText(p), baseDirectory))
            .filter(Boolean)
            .join(", ")
        : "";
      return {
        ...defaultStrategy,
        Icon: ImageIcon,
        title: t("generate image"),
        secondaryText: toPlainText(input.ImageName) || undefined,
        details: includeOutput
          ? compactDetails([
              detail(t("Aspect ratio"), toPlainText(input.AspectRatio)),
              detail(t("Reference images"), refs),
              detail(t("Prompt"), toStringValue(input.Prompt)),
            ])
          : [],
        showInputPreview: hasUnrenderedKeys(input, GENERATE_IMAGE_KEYS),
        outputContent: includeOutput ? getResultContent() : EMPTY_TOOL_OUTPUT,
      };
    }

    case "run_workflow": {
      const script = toPlainText(input.ScriptPath)
        ? getDisplayPath(toPlainText(input.ScriptPath), baseDirectory)
        : toStringValue(input.Script);
      const unwrapped = includeOutput ? getUnwrapped() : null;
      return {
        ...defaultStrategy,
        Icon: Wrench,
        title: t("run workflow"),
        secondaryText: toPlainText(input.Description) || undefined,
        details: unwrapped
          ? compactDetails([
              detail(t("Script"), script),
              detail(t("Workdir"), getDisplayPath(toPlainText(input.Cwd), baseDirectory)),
              getFullOutputDetail(unwrapped),
            ])
          : [],
        showInputPreview: hasUnrenderedKeys(input, RUN_WORKFLOW_KEYS),
        outputContent: unwrapped ? getResultContent(unwrapped) : EMPTY_TOOL_OUTPUT,
      };
    }

    case "finish": {
      const isError = state.status === "error";
      const unwrapped = includeOutput ? getUnwrapped() : null;
      const renderedResult =
        includeOutput && !isError
          ? (buildSemanticOutputContent(input.result) ??
            (typeof input.result === "string" && input.result.trim()
              ? plainTextContent(input.result)
              : null))
          : null;
      return {
        ...defaultStrategy,
        Icon: CheckCircle2,
        title: t("finish"),
        secondaryText: undefined,
        details:
          unwrapped && !isError
            ? compactDetails([detail(t("Result"), firstLine(unwrapped.text, 140))])
            : [],
        contentLabel: isError ? t("Error") : t("Result"),
        showInputPreview:
          isError ||
          (includeOutput && !renderedResult && input.result != null) ||
          hasUnrenderedKeys(input, FINISH_KEYS),
        outputContent: !unwrapped
          ? EMPTY_TOOL_OUTPUT
          : isError
            ? getResultContent(unwrapped)
            : (renderedResult ?? getResultContent(unwrapped)),
        rawOutput:
          unwrapped && renderedResult && unwrapped.text
            ? state.outputValue || undefined
            : undefined,
      };
    }

    default: {
      const mcp = extractMcpTool(tool.tool, input);
      if (mcp) {
        if (!includeOutput) {
          return {
            ...defaultStrategy,
            Icon: Plug,
            title: `${mcp.server} · ${humanizeName(mcp.operation)}`,
            secondaryText: mcp.summary || firstSummaryValue(mcp.args, baseDirectory) || undefined,
            details: [],
            contentLabel: t("Result"),
            showInputPreview: mcp.hasOuterUnrendered,
            outputContent: EMPTY_TOOL_OUTPUT,
          };
        }
        const unwrapped = getUnwrapped();
        const { details: argDetails, hasOmittedArgs } = buildMcpArgDetails(
          mcp.args,
          mcp.renderedArgSummaryKey,
          baseDirectory,
        );
        const semanticOutput =
          state.status !== "error" ? buildSemanticOutputContent(unwrapped.text) : null;
        const requestItems: PropertyItem[] =
          !unwrapped.text && !state.errorValue
            ? Object.entries(mcp.args)
                .filter(([key]) => key !== mcp.renderedArgSummaryKey)
                .map(([label, value]) => ({ label, value }))
            : [];
        const showingRequestAsOutput =
          state.status !== "error" &&
          !unwrapped.text &&
          !state.errorValue &&
          requestItems.length > 0;
        return {
          ...defaultStrategy,
          Icon: Plug,
          title: `${mcp.server} · ${humanizeName(mcp.operation)}`,
          secondaryText: mcp.summary || firstSummaryValue(mcp.args, baseDirectory) || undefined,
          details: compactDetails([...argDetails, getFullOutputDetail(unwrapped)]),
          contentLabel: showingRequestAsOutput ? t("Request") : t("Result"),
          showInputPreview:
            mcp.hasOuterUnrendered ||
            (!showingRequestAsOutput &&
              (hasOmittedArgs || (argDetails.length === 0 && Object.keys(mcp.args).length > 0))),
          outputContent:
            state.status === "error"
              ? getResultContent(unwrapped)
              : (semanticOutput ??
                (showingRequestAsOutput
                  ? { kind: "property-list", items: requestItems }
                  : plainTextContent(getResultText(unwrapped)))),
        };
      }

      const summary = toPlainText(input.toolSummary) || toPlainText(input.toolAction);
      const unwrapped = includeOutput ? getUnwrapped() : null;
      return {
        ...defaultStrategy,
        secondaryText: summary || defaultStrategy.secondaryText,
        details: unwrapped ? compactDetails([getFullOutputDetail(unwrapped)]) : [],
        outputContent: unwrapped ? getSemanticOrPlain(unwrapped.text) : EMPTY_TOOL_OUTPUT,
      };
    }
  }
}
