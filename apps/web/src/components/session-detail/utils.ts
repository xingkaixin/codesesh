/**
 * Shared leaf helpers used across the session-detail logic modules.
 * None depend on React or on each other beyond what's defined here.
 */

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseInputCandidate(inputValue: unknown) {
  if (typeof inputValue !== "string") return inputValue;
  try {
    return JSON.parse(inputValue) as unknown;
  } catch {
    return inputValue;
  }
}

export function compactText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toPlainText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toStringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function parseJsonText<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function normalizeEscapedNewlines(text: string): string {
  return text.replaceAll(/\\n/g, "\n");
}
