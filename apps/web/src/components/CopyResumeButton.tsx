import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

interface CopyResumeButtonProps {
  sessionId: string;
  directory?: string | null;
  className?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCommand(sessionId: string, directory?: string | null): string {
  const quotedId = shellQuote(sessionId);
  const trimmed = directory?.trim();
  if (!trimmed) {
    return `claude --resume ${quotedId}`;
  }
  return `cd ${shellQuote(trimmed)} && claude --resume ${quotedId}`;
}

async function writeToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback (e.g. insecure context).
    }
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export function CopyResumeButton({ sessionId, directory, className = "" }: CopyResumeButtonProps) {
  const [copied, setCopied] = useState(false);
  const command = buildCommand(sessionId, directory);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void writeToClipboard(command).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
      aria-label={copied ? "Resume command copied" : "Copy claude --resume command"}
      title={copied ? "Copied" : `Copy: ${command}`}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-sm border transition-colors ${className} ${
        copied
          ? "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-text)]"
          : "border-transparent text-[var(--console-muted)] opacity-70 hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] hover:opacity-100"
      }`}
    >
      {copied ? (
        <Check className="size-3" strokeWidth={1.8} />
      ) : (
        <Copy className="size-3" strokeWidth={1.8} />
      )}
    </button>
  );
}
