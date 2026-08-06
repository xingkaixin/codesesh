import { type DiffTone, diffToneClass } from "./diff-tone";

interface UnifiedDiffOutputProps {
  text: string;
}

function getLineKey(line: string, occurrence: number) {
  return `${line}:${occurrence}`;
}

function getUnifiedDiffLineTone(line: string): DiffTone {
  if (/^(Index:|diff\s|===)/.test(line)) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

export function UnifiedDiffOutput({ text }: UnifiedDiffOutputProps) {
  const lines = text.split("\n");
  const lineOccurrences = new Map<string, number>();

  return (
    <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-sunken)] p-3 text-xs leading-relaxed">
      {lines.map((line) => {
        const occurrence = lineOccurrences.get(line) ?? 0;
        lineOccurrences.set(line, occurrence + 1);
        return (
          <span
            key={getLineKey(line, occurrence)}
            className={`block rounded-[2px] px-1 ${diffToneClass(getUnifiedDiffLineTone(line))}`}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}
