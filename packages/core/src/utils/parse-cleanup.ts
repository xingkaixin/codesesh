const INTERNAL_TAGS = [
  "command-message",
  "command-name",
  "local-command-stdout",
  "system-reminder",
];

const INTERNAL_EVENT_TYPES = new Set([
  "progress",
  "file history snapshot",
  "file-history snapshot",
  "file_history snapshot",
  "queue operation",
  "queue-operation",
  "queue_operation",
  "last prompt",
  "last-prompt",
  "last_prompt",
]);

function blockTagPattern(tag: string): RegExp {
  return new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
}

function blockTagLinePattern(tag: string): RegExp {
  return new RegExp(
    `(^|\\r?\\n)[ \\t]*<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>[ \\t]*(?:\\r?\\n|$)`,
    "gi",
  );
}

function openBlockTagPattern(tag: string): RegExp {
  return new RegExp(`\\n*<${tag}\\b[^>]*>[\\s\\S]*$`, "gi");
}

function looseTagPattern(tag: string): RegExp {
  return new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
}

export function isInternalEventType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  return INTERNAL_EVENT_TYPES.has(normalized);
}

export function cleanDisplayText(text: string): string | null {
  let cleaned = text;

  for (const tag of INTERNAL_TAGS) {
    cleaned = cleaned.replace(blockTagLinePattern(tag), "$1");
    cleaned = cleaned.replace(blockTagPattern(tag), "");
    cleaned = cleaned.replace(openBlockTagPattern(tag), "");
  }

  for (const tag of INTERNAL_TAGS) {
    cleaned = cleaned.replace(looseTagPattern(tag), "");
  }

  cleaned = cleaned.replace(/[ \t]+(?=\r?\n|$)/g, "").replace(/(?:\r?\n)+$/g, "");

  return cleaned.trim() ? cleaned : null;
}

export function firstVisibleLine(text: string): string | null {
  const cleaned = cleanDisplayText(text);
  if (!cleaned) return null;
  return (
    cleaned
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? null
  );
}
