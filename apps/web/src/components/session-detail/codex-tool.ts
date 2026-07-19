import type { ToolOutputContent, ToolOutputLanguage } from "../tool-output/types";

export interface ToolDetailItem {
  label: string;
  value: string;
}

export interface CodexBashOutputAnalysis {
  text: string;
  language: ToolOutputLanguage;
  isCode: boolean;
  sourcePath?: string;
  confidence: "path" | "content" | "plain";
}

function toRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toPlainText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toStringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toDisplayValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${value}`;
  }
  return "";
}

function normalizeEscapedNewlines(text: string) {
  return text.replace(/\\n/g, "\n");
}

function stripRecommendedSuffix(value: string) {
  return value.replace(/\s*\(Recommended\)\s*$/i, "").trim();
}

function normalizeRecommendedLabel(value: string) {
  const trimmed = value.trim();
  return {
    label: stripRecommendedSuffix(trimmed),
    recommended: /\(Recommended\)\s*$/i.test(trimmed),
  };
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength = 88) {
  const compact = compactText(text);
  if (!compact) {
    return "";
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function buildQuestionSummary(headers: string[], questionCount: number) {
  const parts = [`${questionCount} questions`, ...headers.filter(Boolean).slice(0, 2)];
  return truncateText(parts.join(" · "), 96);
}

function extractTextSegments(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextSegments(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const textValue = record.text;
    if (typeof textValue === "string") {
      return [textValue];
    }
    const contentValue = record.content;
    if (contentValue !== undefined) {
      return extractTextSegments(contentValue);
    }
  }

  return [];
}

function joinToolText(value: unknown) {
  const segments = extractTextSegments(value)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.join("\n");
}

function parseJsonText<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function stripCodexShellOutputPreamble(text: string) {
  const normalized = normalizeEscapedNewlines(text);
  const lines = normalized.split("\n");
  if (lines.length < 5) {
    return text;
  }

  const hasExpectedHeader =
    /^Chunk ID:\s+\S+/.test(lines[0] || "") &&
    /^Wall time:\s+/.test(lines[1] || "") &&
    /^Process (?:exited with code \d+|running with session ID \d+)/.test(lines[2] || "") &&
    /^Original token count:\s+\d+/.test(lines[3] || "") &&
    /^Output:$/.test(lines[4] || "");

  if (!hasExpectedHeader) {
    return text;
  }

  let bodyStart = 5;
  while (bodyStart < lines.length && lines[bodyStart]?.trim() === "") {
    bodyStart += 1;
  }

  const stripped = lines.slice(bodyStart).join("\n");
  return stripped.trim() ? stripped : text;
}

function appendDetail(details: ToolDetailItem[], label: string, value: string) {
  if (!value.trim()) {
    return;
  }
  details.push({ label, value });
}

function stripWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isSafeSinglePathToken(value: string) {
  if (!value.trim()) {
    return false;
  }

  return !/[|&;<>()$`*?{}[\]\\]/.test(value);
}

function normalizePathCandidate(value: string) {
  const normalized = stripWrappingQuotes(value.trim());
  if (!isSafeSinglePathToken(normalized)) {
    return null;
  }
  return normalized;
}

export function extractReadableFilePathFromCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const nlSedMatch = trimmed.match(/^nl\s+-ba\s+([^\s]+)\s*\|\s*sed\s+-n\s+['"][^'"]+['"]$/);
  if (nlSedMatch) {
    return normalizePathCandidate(nlSedMatch[1] || "");
  }

  const singleFilePatterns = [
    /^cat\s+([^\s]+)$/,
    /^sed\s+-n\s+['"][^'"]+['"]\s+([^\s]+)$/,
    /^head\s+-n\s+\d+\s+([^\s]+)$/,
    /^tail\s+-n\s+\d+\s+([^\s]+)$/,
  ];

  for (const pattern of singleFilePatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return normalizePathCandidate(match[1] || "");
    }
  }

  return null;
}

export function stripLineNumberPrefixes(text: string) {
  const lines = text.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim());
  if (nonEmptyLines.length === 0) {
    return text;
  }

  const numberedLinePattern = /^\s*\d+(?:\t|\|\s?)/;
  const numberedLineCount = nonEmptyLines.filter((line) => numberedLinePattern.test(line)).length;
  if (numberedLineCount / nonEmptyLines.length < 0.6) {
    return text;
  }

  return lines.map((line) => line.replace(/^\s*\d+(?:\t|\|\s?)/, "")).join("\n");
}

function looksLikeTerminalNoise(text: string) {
  return (
    /\b(Test Files|Tests|Coverage report|coverage: platform|Ran \d+ tests)\b/.test(text) ||
    /^(PASS|FAIL|stdout\s+\|)/m.test(text) ||
    /\bmodules transformed\b/.test(text)
  );
}

export function detectLanguageFromContent(text: string): ToolOutputLanguage | null {
  const trimmed = text.trim();
  if (!trimmed || looksLikeTerminalNoise(trimmed)) {
    return null;
  }

  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && parseJsonText(trimmed) != null) {
    return "json";
  }

  if (/<(!DOCTYPE html|html\b|body\b|div\b|span\b|main\b|section\b|svg\b|\/[a-z])/i.test(trimmed)) {
    return "markup";
  }

  const markdownSignals = [/^#{1,6}\s/m, /^[-*]\s/m, /^\d+\.\s/m, /^```/m].filter((pattern) =>
    pattern.test(trimmed),
  ).length;
  if (markdownSignals >= 1 && !/[{};]\s*$/.test(trimmed)) {
    return "markdown";
  }

  const yamlLikeLines = trimmed.match(/^[A-Za-z0-9_-]+:\s.+$/gm) || [];
  if (
    yamlLikeLines.length >= 2 &&
    !/\b(import|export|const|let|function|class)\b/.test(trimmed) &&
    !/[{}()[\];]/.test(trimmed)
  ) {
    return "yaml";
  }

  const pythonSignals = [
    /^(from\s+\S+\s+import\s+.+|import\s+\S+)/m,
    /^def\s+\w+\(/m,
    /^class\s+\w+[:(]/m,
  ].filter((pattern) => pattern.test(trimmed)).length;
  if (
    pythonSignals >= 2 ||
    (/^(from\s+\S+\s+import\s+.+|import\s+\S+)/m.test(trimmed) && /^def\s+\w+\(/m.test(trimmed))
  ) {
    return "python";
  }

  const tsSignals = [
    /\binterface\s+\w+/,
    /\btype\s+\w+\s*=/,
    /\bimplements\b/,
    /\bas const\b/,
    /:\s*[A-Z][A-Za-z0-9_<>,[\] |&?]+/,
  ].filter((pattern) => pattern.test(trimmed)).length;
  if (tsSignals >= 1 && /\b(import|export|const|let|function|class)\b/.test(trimmed)) {
    return "typescript";
  }

  const jsSignals = [
    /^\s*import\s.+from\s/m,
    /^\s*export\s/m,
    /\b(const|let|function|class)\b/,
  ].filter((pattern) => pattern.test(trimmed)).length;
  if (jsSignals >= 2) {
    return "javascript";
  }

  return null;
}

export function analyzeCodexBashOutput(
  command: string,
  outputText: string,
  detectLanguageByFilePath: (filePath: string) => ToolOutputLanguage,
): CodexBashOutputAnalysis {
  const cleanedText = stripCodexShellOutputPreamble(outputText);
  const sourcePath = extractReadableFilePathFromCommand(command);
  if (sourcePath) {
    const language = detectLanguageByFilePath(sourcePath);
    const displayText = stripLineNumberPrefixes(cleanedText);
    return {
      text: displayText,
      language,
      isCode: language !== "text",
      sourcePath,
      confidence: "path",
    };
  }

  const contentLanguage = detectLanguageFromContent(cleanedText);
  if (contentLanguage) {
    return {
      text: cleanedText,
      language: contentLanguage,
      isCode: true,
      confidence: "content",
    };
  }

  return {
    text: cleanedText,
    language: "text",
    isCode: false,
    confidence: "plain",
  };
}

export function buildCodexExecCommandDisplay(
  inputValue: unknown,
  outputText: string,
  detectLanguageByFilePath: (filePath: string) => ToolOutputLanguage,
  formatPathForDisplay: (path: string) => string = (path) => path,
  formatTextForDisplay: (text: string) => string = (text) => text,
) {
  const input = toRecord(inputValue);
  const command = toPlainText(input.cmd);
  const workdir = toPlainText(input.workdir);
  const escalation = toPlainText(input.sandbox_permissions);
  const justification = toPlainText(input.justification);
  const displayCommand = formatTextForDisplay(command);

  const details: ToolDetailItem[] = [];
  appendDetail(details, "Command", displayCommand);
  appendDetail(details, "Workdir", formatPathForDisplay(workdir));
  appendDetail(details, "Escalation", escalation);
  appendDetail(details, "Justification", justification);

  const commandPreview = truncateText(displayCommand);
  const secondaryText = justification
    ? [justification, commandPreview].filter(Boolean).join("\n")
    : commandPreview || undefined;
  const outputAnalysis = analyzeCodexBashOutput(command, outputText, detectLanguageByFilePath);

  return {
    secondaryText,
    details,
    outputAnalysis,
  };
}

export function buildCodexWriteStdinDisplay(
  inputValue: unknown,
  outputText: string,
  detectLanguageByFilePath: (filePath: string) => ToolOutputLanguage,
) {
  const input = toRecord(inputValue);
  const sessionId = toDisplayValue(input.session_id);
  const chars = toStringValue(input.chars);
  const mode = chars ? "stdin" : "poll";

  const details: ToolDetailItem[] = [];
  appendDetail(details, "Session", sessionId);
  details.push({
    label: "Chars",
    value: chars || "(empty)",
  });

  return {
    secondaryText: sessionId ? `session #${sessionId} · ${mode}` : mode,
    details,
    outputAnalysis: analyzeCodexBashOutput("", outputText, detectLanguageByFilePath),
  };
}

export function buildCodexRequestUserInputDisplay(
  inputValue: unknown,
  outputText: string,
): {
  secondaryText?: string;
  details: ToolDetailItem[];
  outputContent: ToolOutputContent;
} {
  const input = toRecord(inputValue);
  const rawQuestions = Array.isArray(input.questions) ? input.questions : null;
  if (!rawQuestions || rawQuestions.length === 0) {
    return {
      secondaryText: undefined,
      details: [],
      outputContent: {
        kind: "plain",
        text: outputText,
        language: "text",
        isCode: false,
      },
    };
  }

  const parsedOutput = parseJsonText<{ answers?: Record<string, { answers?: unknown }> }>(
    outputText,
  );
  const answersById = toRecord(parsedOutput?.answers);

  const questions = rawQuestions
    .map((questionValue) => {
      const question = toRecord(questionValue);
      const questionId = toPlainText(question.id);
      const rawAnswerRecord = toRecord(answersById[questionId]);
      const rawAnswers = Array.isArray(rawAnswerRecord.answers) ? rawAnswerRecord.answers : [];
      const answers = rawAnswers
        .map((answer) => (typeof answer === "string" ? stripRecommendedSuffix(answer) : ""))
        .filter(Boolean);

      const options = Array.isArray(question.options)
        ? question.options
            .map((optionValue) => {
              const option = toRecord(optionValue);
              const normalizedLabel = normalizeRecommendedLabel(toPlainText(option.label));
              if (!normalizedLabel.label) {
                return null;
              }
              return {
                label: normalizedLabel.label,
                description: toPlainText(option.description) || undefined,
                recommended: normalizedLabel.recommended || undefined,
              };
            })
            .filter((option): option is NonNullable<typeof option> => option != null)
        : [];

      const questionText = toPlainText(question.question);
      if (!questionText) {
        return null;
      }

      return {
        header: toPlainText(question.header) || undefined,
        question: questionText,
        options,
        answers,
      };
    })
    .filter((question): question is NonNullable<typeof question> => question != null);

  if (questions.length === 0) {
    return {
      secondaryText: undefined,
      details: [],
      outputContent: {
        kind: "plain",
        text: outputText,
        language: "text",
        isCode: false,
      },
    };
  }

  return {
    secondaryText: buildQuestionSummary(
      questions.map((question) => question.header || ""),
      questions.length,
    ),
    details: [],
    outputContent: {
      kind: "question-list",
      questions,
    },
  };
}

export function buildCodexUpdatePlanDisplay(inputValue: unknown) {
  const input = toRecord(inputValue);
  const explanation = toPlainText(input.explanation);
  const steps = Array.isArray(input.plan) ? input.plan : [];

  const counts = new Map<string, number>();
  const lines = steps.map((entry) => {
    const item = toRecord(entry);
    const status = toPlainText(item.status) || "pending";
    const step = toPlainText(item.step) || toPlainText(item.content);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const marker = status === "completed" ? "x" : status === "in_progress" ? "~" : " ";
    return `- [${marker}] ${step || "(empty step)"}`;
  });

  const details: ToolDetailItem[] = [...counts.entries()].map(([status, count]) => ({
    label: status,
    value: String(count),
  }));

  return {
    secondaryText:
      explanation ||
      [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · ") ||
      undefined,
    details,
    text: lines.join("\n") || explanation || "No plan captured.",
  };
}

function summarizeWebRunItems(items: unknown[], field: string) {
  return items
    .map((item) => toPlainText(toRecord(item)[field]))
    .filter(Boolean)
    .join(" · ");
}

export function buildCodexWebRunDisplay(inputValue: unknown) {
  const input = toRecord(inputValue);

  if (Array.isArray(input.search_query)) {
    return {
      title: "web search",
      secondaryText: summarizeWebRunItems(input.search_query, "q") || undefined,
    };
  }
  if (Array.isArray(input.open)) {
    return {
      title: "web open",
      secondaryText: summarizeWebRunItems(input.open, "ref_id") || undefined,
    };
  }

  const action = Object.keys(input)[0] || "run";
  return { title: `web ${action}`, secondaryText: undefined };
}

export function buildCodexViewImageDisplay(
  inputValue: unknown,
  formatPathForDisplay: (path: string) => string,
) {
  const input = toRecord(inputValue);
  const path = toPlainText(input.path);
  const detail = toPlainText(input.detail);
  const displayPath = path ? formatPathForDisplay(path) : "";

  const details: ToolDetailItem[] = [];
  appendDetail(details, "Image", displayPath);
  appendDetail(details, "Detail", detail);

  return { secondaryText: displayPath || undefined, details };
}

export function extractCodexToolText(value: unknown) {
  return joinToolText(value);
}
