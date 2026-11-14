import { t } from "../../../i18n/translate";
/**
 * Grok tool display strategy for native result envelopes.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "@codesesh/contract";
import type { TaskListItem } from "../../tool-output/types";
import type { ToolDetailItem } from "../codex-tool";
import { buildStructuredDiffFromTexts } from "../diff";
import {
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
} from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  buildSemanticOutputContent,
  compactText,
  getOutputOrErrorText,
  normalizeToolName,
  toPlainText,
  toRecord,
  toDisplayText,
  toStringValue,
} from "../tool-normalize";
import {
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildFileWriteStrategy,
  buildSearchToolStrategy,
} from "./shared";
import { Bot, FileSearch, ListTodo, SquareTerminal, Wrench } from "../../ui/icons";

const READ_ERROR_KEYS = [
  "FileNotFound",
  "IsADirectory",
  "PermissionDenied",
  "FileTooLarge",
  "FileReadError",
  "ImageSizeError",
] as const;

function integerValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function payloadFromState(state: NormalizedToolState) {
  const output = toRecord(state.outputValue);
  return Object.keys(output).length > 0 ? output : toRecord(state.errorValue);
}

function payloadDetails(payload: Record<string, unknown>, omitted: string[]) {
  return Object.entries(payload)
    .filter(([key, value]) => !omitted.includes(key) && value != null)
    .map(([label, value]) => ({
      label,
      value: typeof value === "string" ? value : toDisplayText(value),
    }));
}

function messageFromPayload(payload: Record<string, unknown>) {
  const directMessage =
    toPlainText(payload.message) || toPlainText(payload.content) || toPlainText(payload.text);
  if (directMessage) return directMessage;

  for (const key of READ_ERROR_KEYS) {
    const message = toPlainText(payload[key]);
    if (message) return message;
  }

  const error = toRecord(payload.Error);
  return toPlainText(error.message) || toPlainText(payload.error);
}

function buildReadDetails(
  fileContent: Record<string, unknown>,
  imageContent: Record<string, unknown>,
  pdfContent: Record<string, unknown>,
) {
  const details: ToolDetailItem[] = [];
  const totalLines = integerValue(fileContent.total_lines);
  const offset = integerValue(fileContent.offset);
  const limit = integerValue(fileContent.limit);
  const mimeType = toPlainText(imageContent.mime_type);
  const totalPages = integerValue(pdfContent.total_pages);

  if (totalLines !== null && totalLines >= 0) {
    details.push({ label: t("Lines"), value: String(totalLines) });
  }
  if (offset !== null && offset >= 0) details.push({ label: t("Offset"), value: String(offset) });
  if (limit !== null && limit >= 0) details.push({ label: t("Limit"), value: String(limit) });
  if (mimeType) details.push({ label: t("Format"), value: mimeType });
  if (totalPages !== null && totalPages >= 0) {
    details.push({ label: t("Pages"), value: String(totalPages) });
  }
  return details;
}

function buildReadMedia(
  imageContent: Record<string, unknown>,
  pdfContent: Record<string, unknown>,
) {
  const parts: unknown[] = [];
  const imageData = toStringValue(imageContent.data);
  const imageMimeType = toPlainText(imageContent.mime_type);
  if (imageData && imageMimeType) {
    parts.push({ type: "image", data: imageData, mime_type: imageMimeType });
  }

  const pages = Array.isArray(pdfContent.pages) ? pdfContent.pages : [];
  for (const pageValue of pages) {
    const page = toRecord(pageValue);
    const data = toStringValue(page.data);
    const mimeType = toPlainText(page.mime_type);
    if (data && mimeType) parts.push({ type: "image", data, mime_type: mimeType });
  }

  return buildSemanticOutputContent(parts);
}

function buildGrokReadStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  baseDirectory?: string,
) {
  const input = toRecord(state.inputValue);
  const payload = payloadFromState(state);
  const fileContent = toRecord(payload.FileContent);
  const imageContent = toRecord(payload.ImageContent);
  const pdfContent = toRecord(payload.PdfPageImages);
  const filePath =
    toPlainText(fileContent.absolute_path) ||
    toPlainText(input.target_file) ||
    toPlainText(input.file_path);
  const displayPath = getDisplayPath(filePath, baseDirectory);
  const details = buildReadDetails(fileContent, imageContent, pdfContent);
  const mediaOutput = buildReadMedia(imageContent, pdfContent);

  if (mediaOutput) {
    return buildFileReadStrategy({
      defaultStrategy,
      state,
      filePath,
      displayPath,
      details,
      outputContent: mediaOutput,
    });
  }

  if (Object.keys(imageContent).length > 0 || Object.keys(pdfContent).length > 0) {
    return buildFileReadStrategy({
      defaultStrategy,
      state,
      filePath,
      displayPath,
      details,
      outputContent: {
        kind: "plain",
        text:
          Object.keys(pdfContent).length > 0
            ? t("PDF preview unavailable.")
            : t("Image preview unavailable."),
        language: "text",
        isCode: false,
      },
    });
  }

  if (Object.keys(fileContent).length > 0) {
    const rawText = toStringValue(fileContent.raw_output);
    const content = rawText || toStringValue(fileContent.content) || t("File is empty.");
    return buildFileReadStrategy({
      defaultStrategy,
      state,
      filePath,
      displayPath,
      details,
      text: content,
    });
  }

  const errorText = messageFromPayload(payload) || getOutputOrErrorText(state);
  return buildFileReadStrategy({
    defaultStrategy,
    state,
    filePath,
    displayPath,
    details,
    outputContent: { kind: "plain", text: errorText, language: "text", isCode: false },
  });
}

function decodeByteText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const bytes = value;
    if (
      bytes.every(
        (value) =>
          typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255,
      )
    ) {
      return new TextDecoder().decode(Uint8Array.from(bytes));
    }
  }
  return null;
}

function buildGrokBashStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const input = toRecord(state.inputValue);
  const payload = payloadFromState(state);
  const command = toStringValue(input.command) || toStringValue(payload.command);
  const description = toPlainText(input.description) || toPlainText(payload.description);
  if (payload.type === "BackgroundTaskStarted") {
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: "task",
      secondaryText: toPlainText(payload.task_id) || description || undefined,
      details: payloadDetails(payload, ["type", "summary", "retrieval_hint"]),
      outputContent:
        payload.status === "running"
          ? {
              kind: "task-list",
              items: [
                {
                  label: toStringValue(payload.summary) || toPlainText(payload.task_id),
                  status: "in_progress",
                  detail: toStringValue(payload.retrieval_hint) || undefined,
                },
              ],
            }
          : defaultStrategy.outputContent,
    };
  }
  const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
  const currentDirectory = getDisplayPath(toPlainText(payload.current_dir), baseDirectory);
  const outputFile = getDisplayPath(toPlainText(payload.output_file), baseDirectory);
  const exitCode = integerValue(payload.exit_code);
  const signal = toPlainText(payload.signal);
  const details: ToolDetailItem[] = [];

  if (displayCommand) details.push({ label: t("Command"), value: displayCommand });
  if (currentDirectory) details.push({ label: t("Workdir"), value: currentDirectory });
  if (exitCode !== null) details.push({ label: t("Exit code"), value: String(exitCode) });
  if (signal) details.push({ label: t("Signal"), value: signal });
  if (payload.timed_out === true) details.push({ label: t("Timed out"), value: t("Yes") });
  if (payload.truncated === true) {
    details.push({ label: t("Output"), value: t("Truncated") });
    if (outputFile) details.push({ label: t("Full output"), value: outputFile });
  }

  const outputText =
    decodeByteText(payload.output) ??
    (toStringValue(payload.output_for_prompt) ||
      messageFromPayload(payload) ||
      getOutputOrErrorText(state));
  const failed = state.status === "error" || (exitCode !== null && exitCode !== 0);
  return {
    ...defaultStrategy,
    Icon: SquareTerminal,
    title: "bash",
    secondaryText: description || compactText(displayCommand).slice(0, 120) || undefined,
    details,
    showInputPreview: false,
    contentLabel: failed ? t("Error") : t("Terminal output"),
    outputContent: {
      kind: "plain",
      text: outputText || t("No output captured."),
      language: "text",
      isCode: false,
    },
  };
}

function buildGrokTaskOutputStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const payload = payloadFromState(state);
  const result = toRecord(payload.Result);
  if (decodeByteText(result.output) === null) return defaultStrategy;

  const terminal = buildGrokBashStrategy(
    { ...state, outputValue: result },
    defaultStrategy,
    baseDirectory,
  );
  return {
    ...terminal,
    Icon: Bot,
    title: "task",
    secondaryText: toPlainText(result.task_id) || undefined,
    details: [
      ...payloadDetails(result, ["output"]),
      ...payloadDetails(payload, ["type", "Result"]),
    ],
    showInputPreview: true,
  };
}

function buildGrokFileStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  write: boolean,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const payload = payloadFromState(state);
  const applied = toRecord(payload.EditsApplied);
  if (state.status !== "completed" || Object.keys(applied).length === 0) return defaultStrategy;

  const filePath = toPlainText(applied.absolute_path) || getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);
  const details = [
    ...payloadDetails(payload, ["type", "EditsApplied"]),
    ...payloadDetails(applied, [
      "absolute_path",
      "old_string",
      "new_string",
      "edits",
      "tool_output_for_prompt_concise",
    ]),
  ];
  if (write) {
    if (typeof applied.new_string !== "string") return defaultStrategy;
    const strategy = buildFileWriteStrategy({ defaultStrategy, state, filePath, displayPath });
    return {
      ...strategy,
      details,
      showInputPreview: true,
      outputContent:
        strategy.outputContent.kind === "plain"
          ? {
              ...strategy.outputContent,
              text: applied.new_string || t("File is empty."),
              isCode: applied.new_string.length > 0,
            }
          : strategy.outputContent,
    };
  }

  const edits = toRecord(applied.edits);
  const entries = Array.isArray(edits.details) ? edits.details : [applied];
  if (
    entries.some((value) => {
      const edit = toRecord(value);
      return typeof edit.old_string !== "string" || typeof edit.new_string !== "string";
    })
  ) {
    return defaultStrategy;
  }
  const blocks = entries.flatMap((value) => {
    const edit = toRecord(value);
    const oldLine = integerValue(edit.old_line);
    const newLine = integerValue(edit.new_line);
    const label =
      oldLine !== null && newLine !== null ? `${displayPath}:${oldLine} → ${newLine}` : displayPath;
    return buildStructuredDiffFromTexts(
      label,
      toStringValue(edit.old_string),
      toStringValue(edit.new_string),
    );
  });
  return {
    ...buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      details,
      outputContent:
        blocks.length > 0 ? { kind: "structured-diff", blocks } : defaultStrategy.outputContent,
    }),
    showInputPreview: true,
  };
}

function buildGrokGrepStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const payload = payloadFromState(state);
  const input = toRecord(state.inputValue);
  const stdout = decodeByteText(payload.stdout);
  const stderr = decodeByteText(payload.stderr);
  const fileMatches = Array.isArray(payload.file_matches) ? payload.file_matches : [];
  const matches = fileMatches.flatMap((value) => {
    const file = toRecord(value);
    const path = getDisplayPath(toPlainText(file.path), baseDirectory);
    const lines = Array.isArray(file.matches) ? file.matches : [];
    return lines.map((value) => {
      const match = toRecord(value);
      return `${path}:${toDisplayText(match.line_number)}: ${toStringValue(match.content)}`;
    });
  });
  if ((stdout === null && matches.length === 0) || (payload.stderr != null && stderr === null)) {
    return defaultStrategy;
  }
  const search = buildSearchToolStrategy({
    defaultStrategy,
    state,
    title: "grep",
    path: toPlainText(input.path),
    pattern: toPlainText(input.pattern),
    baseDirectory,
  });
  return {
    ...search,
    details: [
      ...payloadDetails(payload, ["type", "stdout", "stderr", "file_matches"]),
      ...(stderr ? [{ label: "stderr", value: stderr }] : []),
    ],
    showInputPreview: true,
    outputContent: {
      kind: "plain",
      text: stdout || matches.join("\n") || getOutputOrErrorText(state),
      language: "text",
      isCode: false,
    },
  };
}

function buildGrokTodoStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
): ToolDisplayStrategy {
  const payload = payloadFromState(state);
  const updated = toRecord(payload.TodosUpdated);
  if (state.status !== "completed" || !Array.isArray(updated.todos)) return defaultStrategy;
  const items = updated.todos.map((value): TaskListItem | null => {
    const todo = toRecord(value);
    const status = todo.status;
    if (
      typeof todo.content !== "string" ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return null;
    }
    return {
      label: todo.content,
      status,
      detail: toPlainText(todo.priority) || undefined,
    };
  });
  if (items.some((item) => item === null)) return defaultStrategy;
  return {
    ...defaultStrategy,
    Icon: ListTodo,
    title: "todo",
    secondaryText: undefined,
    details: [
      ...payloadDetails(payload, ["type", "TodosUpdated"]),
      ...payloadDetails(updated, ["todos", "state", "summary_for_prompt"]),
    ],
    outputContent: {
      kind: "task-list",
      items: items.filter((item): item is NonNullable<typeof item> => item !== null),
    },
  };
}

function buildGrokWebFetchStrategy(
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const input = toRecord(state.inputValue);
  const payload = payloadFromState(state);
  const content = toRecord(payload.Content);
  const error = toRecord(payload.Error);
  const redirect = toRecord(payload.CrossHostRedirect);
  const outputLocation = toRecord(content.outputLocation);
  const inputUrl = toPlainText(input.url);
  const url = toPlainText(content.url) || toPlainText(error.url) || inputUrl;
  const statusCode = integerValue(content.status_code);
  const sizeBytes = integerValue(content.bytes);
  const contentType = toPlainText(content.content_type);
  const errorType = toPlainText(payload.error);
  const details: ToolDetailItem[] = [];

  if (statusCode !== null && statusCode >= 0) {
    details.push({ label: t("Status"), value: String(statusCode) });
  }
  if (contentType) details.push({ label: t("Content type"), value: contentType });
  if (sizeBytes !== null && sizeBytes >= 0) {
    details.push({ label: t("Size"), value: t("{0} bytes", [sizeBytes]) });
  }
  if (errorType) details.push({ label: t("Type"), value: errorType });

  const savedPath = getDisplayPath(toPlainText(outputLocation.filePath), baseDirectory);
  const redirectUrl = toPlainText(redirect.redirect_url);
  const redirectHost = toPlainText(redirect.original_host);
  const domain = toPlainText(payload.DomainNotAllowed);
  const contentText = toStringValue(content.content);
  const errorText =
    messageFromPayload(payload) ||
    (redirectUrl
      ? t("Cross-host redirect from {0} to {1}.", [
          redirectHost || t("the original host"),
          redirectUrl,
        ])
      : "") ||
    (domain ? t("Domain not allowed: {0}", [domain]) : "");
  const outputText =
    contentText ||
    errorText ||
    (savedPath ? t("Full content saved to {0}", [savedPath]) : "") ||
    getOutputOrErrorText(state);

  return {
    ...defaultStrategy,
    Icon: FileSearch,
    title: t("web fetch"),
    secondaryText: url || undefined,
    details,
    showInputPreview: false,
    contentLabel: state.status === "error" ? t("Error") : t("Page content"),
    outputContent: { kind: "plain", text: outputText, language: "markdown", isCode: false },
  };
}

export function buildGrokToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = normalizeToolName(tool);
  const nativeTool = tool.tool.trim().toLowerCase();

  if (toolKey === "read" || nativeTool === "read_file") {
    return buildGrokReadStrategy(state, defaultStrategy, baseDirectory);
  }
  if (toolKey === "bash" || nativeTool === "run_terminal_command") {
    return buildGrokBashStrategy(state, defaultStrategy, baseDirectory);
  }
  if (nativeTool === "get_command_or_subagent_output") {
    return buildGrokTaskOutputStrategy(state, defaultStrategy, baseDirectory);
  }
  if (toolKey === "web fetch" || nativeTool === "web_fetch") {
    return buildGrokWebFetchStrategy(state, defaultStrategy, baseDirectory);
  }
  if (nativeTool === "search_replace" || nativeTool === "write") {
    return buildGrokFileStrategy(state, defaultStrategy, nativeTool === "write", baseDirectory);
  }
  if (nativeTool === "grep") {
    return buildGrokGrepStrategy(state, defaultStrategy, baseDirectory);
  }
  if (nativeTool === "todo_write") {
    return buildGrokTodoStrategy(state, defaultStrategy);
  }
  const payload = payloadFromState(state);
  const input = toRecord(state.inputValue);
  const directory = toRecord(payload.Content);
  if (nativeTool === "list_dir" && typeof directory.content === "string") {
    const list = buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: "list",
      path: toPlainText(directory.absolute_root_path) || toPlainText(input.target_directory),
      baseDirectory,
    });
    return {
      ...list,
      details: [
        ...payloadDetails(payload, ["type", "Content"]),
        ...payloadDetails(directory, ["content", "absolute_root_path"]),
      ],
      showInputPreview: true,
      outputContent: { kind: "plain", text: directory.content, language: "text", isCode: false },
    };
  }
  if (nativeTool === "search_tool" && typeof payload.content === "string") {
    const search = buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: "search_tool",
      pattern: toPlainText(input.query),
    });
    return {
      ...search,
      details: payloadDetails(payload, ["type", "content"]),
      showInputPreview: true,
      outputContent: { kind: "plain", text: payload.content, language: "text", isCode: false },
    };
  }
  const mcpOutput = toRecord(payload.output);
  if (
    nativeTool === "use_tool" &&
    typeof mcpOutput.OkayOutput === "string" &&
    Object.keys(mcpOutput).length === 1
  ) {
    return {
      ...defaultStrategy,
      Icon: Wrench,
      secondaryText: toPlainText(input.tool_name) || toPlainText(payload.tool_name) || undefined,
      details: payloadDetails(payload, ["type", "output"]),
      outputContent: buildSemanticOutputContent(mcpOutput.OkayOutput) ?? {
        kind: "plain",
        text: mcpOutput.OkayOutput,
        language: "text",
        isCode: false,
      },
    };
  }
  return defaultStrategy;
}
