import { t } from "../../../i18n/translate";
/**
 * Grok tool display strategy — read_file/run_terminal_command/web_fetch rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
import type { ToolDetailItem } from "../codex-tool";
import { getDisplayPath, getDisplayTextWithRelativePaths } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  buildSemanticOutputContent,
  compactText,
  getOutputOrErrorText,
  normalizeToolName,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { buildDefaultToolStrategy, buildFileReadStrategy } from "./shared";
import { FileSearch, SquareTerminal } from "../../ui/icons";

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

function decodeTerminalOutput(payload: Record<string, unknown>) {
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) {
    const bytes = payload.output;
    if (
      bytes.every(
        (value) =>
          typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255,
      )
    ) {
      return new TextDecoder().decode(Uint8Array.from(bytes));
    }
    return "";
  }
  return toStringValue(payload.output_for_prompt);
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

  const outputText = decodeTerminalOutput(payload) || messageFromPayload(payload);
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
  if (toolKey === "web fetch" || nativeTool === "web_fetch") {
    return buildGrokWebFetchStrategy(state, defaultStrategy, baseDirectory);
  }
  return defaultStrategy;
}
