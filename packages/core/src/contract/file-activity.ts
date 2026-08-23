import type {
  FileActivityKind,
  ReferencedSessionHead,
  SessionFileActivity,
  ToolPart,
} from "./session.js";

export type FileActivityResult = SessionFileActivity & ReferencedSessionHead;

export interface FileToolOperation {
  kind: FileActivityKind;
  path: string;
}

const FILE_TOOL_KINDS: Readonly<Record<string, FileActivityKind>> = {
  read: "read",
  read_file: "read",
  read_file_v2: "read",
  read_text_file: "read",
  readfile: "read",
  view_image: "read",
  apply_patch: "edit",
  edit: "edit",
  edit_file: "edit",
  edit_file_v2: "edit",
  editfile: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  patch: "edit",
  search_replace: "edit",
  str_replace: "edit",
  create_file: "write",
  write: "write",
  write_file: "write",
  writefile: "write",
  delete: "delete",
  delete_file: "delete",
};

const PATCH_KINDS: Readonly<Record<string, FileActivityKind>> = {
  edit_file: "edit",
  update_file: "edit",
  write_file: "write",
  delete_file: "delete",
  move_file: "edit",
};

function toRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function looksLikeFilePath(value: string) {
  const text = value.trim();
  if (!text || text.length > 300 || text.includes("\n")) return false;
  if (/^[a-z]+:\/\//i.test(text) || /[<>{}]/.test(text)) return false;
  if (text.startsWith("/") || text.startsWith("./") || text.startsWith("../")) return true;
  if (text.startsWith("~/") || text.includes("/") || text.includes("\\")) return true;
  return /^[A-Za-z0-9_.@-]+\.[A-Za-z0-9_-]+$/.test(text);
}

function isPathKey(key: string) {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes("command") ||
    normalized.includes("content") ||
    normalized.includes("text") ||
    normalized.includes("prompt") ||
    normalized.includes("url") ||
    normalized.includes("body") ||
    normalized.includes("title") ||
    normalized.includes("description") ||
    normalized === "cwd" ||
    normalized === "workdir" ||
    normalized === "directory"
  ) {
    return false;
  }
  return normalized.includes("file") || normalized.includes("path");
}

function collectPaths(value: unknown, key: string, paths: Set<string>, depth = 0): void {
  if (value == null || depth > 4) return;
  if (typeof value === "string") {
    if (isPathKey(key) && looksLikeFilePath(value)) paths.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, paths, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(nested, nestedKey, paths, depth + 1);
    }
  }
}

function extractPatchOperations(input: unknown): FileToolOperation[] {
  const record = toRecord(input);
  const content = Array.isArray(input)
    ? input
    : Array.isArray(record.content)
      ? record.content
      : [];

  return content.flatMap((entry) => {
    const patch = toRecord(entry);
    const kind = typeof patch.type === "string" ? PATCH_KINDS[patch.type] : undefined;
    const pathValue = patch.path || patch.old_path;
    const path = typeof pathValue === "string" ? pathValue.trim() : "";
    return kind && path ? [{ kind, path }] : [];
  });
}

export function classifyFileTool(part: Pick<ToolPart, "tool">): FileActivityKind | null {
  return FILE_TOOL_KINDS[part.tool.trim().toLowerCase()] ?? null;
}

export function extractFileToolOperations(
  part: Pick<ToolPart, "tool" | "state">,
): FileToolOperation[] {
  const patchOperations = extractPatchOperations(part.state.input);
  if (patchOperations.length > 0) return patchOperations;

  const kind = classifyFileTool(part);
  if (!kind) return [];

  const paths = new Set<string>();
  collectPaths(part.state.input, "", paths);
  return [...paths].map((path) => ({ kind, path }));
}
