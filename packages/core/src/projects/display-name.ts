export function fallbackDisplayName(input: string): string {
  if (input === "/") return "(root)";
  const trimmed = input.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}
