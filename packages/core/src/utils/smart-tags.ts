import type { MessagePart, SessionData, SmartTag } from "../types/index.js";

const TAG_ORDER: SmartTag[] = [
  "bugfix",
  "refactoring",
  "feature-dev",
  "testing",
  "docs",
  "git-ops",
  "build-deploy",
  "exploration",
  "planning",
];

const USER_RULES: Array<[SmartTag, RegExp]> = [
  ["bugfix", /\b(fix|bug|error|crash|exception|fail(?:ed|ure)?)\b|修复|错误|报错|崩溃|异常/i],
  ["refactoring", /\b(refactor|rename|simplify|clean up|cleanup)\b|重构|重命名|简化|清理/i],
  ["feature-dev", /\b(add|create|implement|new|support|build)\b|新增|创建|实现|增加|开发|支持/i],
  ["docs", /\b(document|documentation|readme|docs?)\b|文档|说明/i],
];

const TESTING_COMMAND_RE = /\b(pytest|vitest|jest|mocha|pnpm\s+test|npm\s+test|yarn\s+test)\b/i;
const GIT_COMMAND_RE = /\bgit\s+(push|commit|merge|branch|checkout|switch|rebase|tag)\b/i;
const BUILD_DEPLOY_COMMAND_RE =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?build|docker|pm2|deploy|vercel|netlify)\b/i;
const DOC_PATH_RE = /\.(md|mdx|txt|rst|adoc)$/i;
const READ_TOOL_RE = /\b(read|grep|glob|websearch|web_search|search|find|rg)\b/i;
const EDIT_TOOL_RE = /\b(edit|write|apply_patch|patch|multiedit|notebookedit)\b/i;
const PLAN_TOOL_RE = /\b(enterplanmode|taskcreate|update_plan|plan)\b/i;

export function getSmartTagSourceTimestamp(
  session: Pick<SessionData, "time_created" | "time_updated">,
): number {
  return session.time_updated ?? session.time_created;
}

export function classifySessionTags(session: Pick<SessionData, "messages">): SmartTag[] {
  const tags = new Set<SmartTag>();
  let readToolCount = 0;
  let editToolCount = 0;

  for (const message of session.messages) {
    if (message.role === "user") {
      const text = message.parts.map(partText).join("\n");
      for (const [tag, pattern] of USER_RULES) {
        if (pattern.test(text)) tags.add(tag);
      }
    }

    for (const part of message.parts) {
      if (part.type === "plan") tags.add("planning");
      if (part.type !== "tool") continue;

      const toolName = `${part.tool ?? ""} ${part.title ?? ""}`;
      const toolPayload = stringifyToolPayload(part);

      if (PLAN_TOOL_RE.test(toolName)) tags.add("planning");
      if (READ_TOOL_RE.test(toolName)) readToolCount += 1;
      if (EDIT_TOOL_RE.test(toolName)) editToolCount += 1;

      if (TESTING_COMMAND_RE.test(toolPayload)) tags.add("testing");
      if (GIT_COMMAND_RE.test(toolPayload)) tags.add("git-ops");
      if (BUILD_DEPLOY_COMMAND_RE.test(toolPayload)) tags.add("build-deploy");
      if (hasEditedDocPath(part.state?.arguments) || hasEditedDocPath(part.state?.input)) {
        tags.add("docs");
      }
    }
  }

  if (readToolCount >= 3 && editToolCount <= 1) {
    tags.add("exploration");
  }

  return TAG_ORDER.filter((tag) => tags.has(tag));
}

function partText(part: MessagePart): string {
  return typeof part.text === "string" ? part.text : "";
}

function stringifyToolPayload(part: MessagePart): string {
  return [
    part.tool,
    part.title,
    valueToText(part.input),
    valueToText(part.output),
    valueToText(part.state),
  ]
    .filter(Boolean)
    .join("\n");
}

function valueToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function hasEditedDocPath(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return DOC_PATH_RE.test(value);
  if (Array.isArray(value)) return value.some(hasEditedDocPath);
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "file_path", "targetPath", "target_path"]) {
    const raw = record[key];
    if (typeof raw === "string" && DOC_PATH_RE.test(raw)) return true;
  }

  return Object.values(record).some(hasEditedDocPath);
}
