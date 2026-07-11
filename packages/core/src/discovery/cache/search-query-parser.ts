import type { FileActivityKind, ProjectIdentityKind, SmartTag } from "../../types/index.js";
import { isProjectIdentityKind } from "../../projects/index.js";

export interface SearchQueryFilters {
  agent?: string;
  project?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  cwd?: string;
  tags?: SmartTag[];
  tools?: string[];
  file?: string;
  fileKind?: FileActivityKind;
  costMin?: number;
  costMax?: number;
  costMinExclusive?: boolean;
  costMaxExclusive?: boolean;
}

export interface ParsedSearchQuery {
  text: string;
  filters: SearchQueryFilters;
  hasQualifiers: boolean;
}

function escapeFtsTerm(value: string): string {
  return value.replaceAll('"', '""');
}

export function splitSearchTokens(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inQuote = false;

  for (const char of input) {
    if (char === '"') {
      inQuote = !inQuote;
      token += char;
      continue;
    }
    if (/\s/.test(char) && !inQuote) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (token) tokens.push(token);
  return tokens;
}

export function unwrapSearchValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseCostQualifier(value: string, filters: SearchQueryFilters): void {
  const raw = unwrapSearchValue(value);
  const range = raw.match(/^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/);
  if (range) {
    filters.costMin = Number(range[1]);
    filters.costMax = Number(range[2]);
    return;
  }

  const comparison = raw.match(/^(>=|>|<=|<)(\d+(?:\.\d+)?)$/);
  if (comparison) {
    const amount = Number(comparison[2]);
    if (comparison[1]?.includes(">")) {
      filters.costMin = amount;
      filters.costMinExclusive = comparison[1] === ">";
    } else {
      filters.costMax = amount;
      filters.costMaxExclusive = comparison[1] === "<";
    }
    return;
  }

  const amount = Number(raw);
  if (!Number.isNaN(amount)) {
    filters.costMin = amount;
    filters.costMax = amount;
  }
}

function appendUnique<T>(values: T[] | undefined, value: T): T[] {
  if (values?.includes(value)) return values;
  return [...(values ?? []), value];
}

function isSmartTag(value: string): value is SmartTag {
  return (
    value === "bugfix" ||
    value === "refactoring" ||
    value === "feature-dev" ||
    value === "testing" ||
    value === "docs" ||
    value === "git-ops" ||
    value === "build-deploy" ||
    value === "exploration" ||
    value === "planning"
  );
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const filters: SearchQueryFilters = {};
  const textTokens: string[] = [];
  let hasQualifiers = false;

  for (const token of splitSearchTokens(input)) {
    const match = token.match(/^([a-zA-Z][a-zA-Z_-]*):(.+)$/);
    if (!match) {
      textTokens.push(token);
      continue;
    }

    const key = match[1]!.toLowerCase();
    const value = unwrapSearchValue(match[2]!);
    if (!value) continue;

    let consumed = true;
    if (key === "agent") filters.agent = value.toLowerCase();
    else if (key === "project") filters.project = value;
    else if (key === "projectkey" || key === "project-key") filters.projectKey = value;
    else if (key === "projectkind" || key === "project-kind") {
      if (isProjectIdentityKind(value)) filters.projectKind = value;
      else consumed = false;
    } else if (key === "cwd") filters.cwd = value;
    else if (key === "tool") filters.tools = appendUnique(filters.tools, value.toLowerCase());
    else if (key === "file" || key === "path") filters.file = value;
    else if (key === "kind" || key === "filekind" || key === "file-kind") {
      if (value === "read" || value === "edit" || value === "write" || value === "delete") {
        filters.fileKind = value;
      } else {
        consumed = false;
      }
    } else if (key === "tag" || key === "signal") {
      const tag = value.toLowerCase();
      if (isSmartTag(tag)) filters.tags = appendUnique(filters.tags, tag);
      else consumed = false;
    } else if (key === "cost") {
      parseCostQualifier(value, filters);
    } else {
      consumed = false;
    }

    if (consumed) hasQualifiers = true;
    else textTokens.push(token);
  }

  return {
    text: textTokens.join(" ").trim(),
    filters,
    hasQualifiers,
  };
}

export function toFtsQuery(input: string): string {
  const tokens = splitSearchTokens(input);
  return tokens
    .map((token) => {
      if (/^OR$/i.test(token)) return "OR";
      if (token.startsWith('"') && token.endsWith('"')) {
        return `"${escapeFtsTerm(token.slice(1, -1))}"`;
      }
      return `"${escapeFtsTerm(token)}"`;
    })
    .filter(
      (token, index, values) =>
        token !== "OR" ||
        (index > 0 &&
          index < values.length - 1 &&
          values[index - 1] !== "OR" &&
          values[index + 1] !== "OR"),
    )
    .join(" ");
}
