interface UnifiedDiffOutputProps {
  text: string;
}

function getLineKey(line: string, occurrence: number) {
  return `${line}:${occurrence}`;
}

function getUnifiedDiffLineClassName(line: string) {
  if (/^(Index:|diff\s|===)/.test(line)) {
    return "text-[var(--console-text)] bg-[#f3f4f6]";
  }
  if (line.startsWith("@@")) {
    return "text-[#7c3aed] bg-[#f5f3ff]";
  }
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "text-[#1d4ed8] bg-[#eff6ff]";
  }
  if (line.startsWith("+")) {
    return "text-[#15803d] bg-[#f0fdf4]";
  }
  if (line.startsWith("-")) {
    return "text-[#b91c1c] bg-[#fef2f2]";
  }
  return "text-[var(--console-text)]";
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
            className={`block rounded-[2px] px-1 ${getUnifiedDiffLineClassName(line)}`}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}
