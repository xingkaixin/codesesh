import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { buildResumeCommand } from "../lib/build-resume-command";

interface CopyResumeButtonProps {
  /** Session ID, will be shell-quoted into `--resume <id>`. */
  sessionId: string;
  /**
   * Session directory — pass `session.directory` from SessionHead.
   *
   * Why this field specifically: in claudecode adapter, SessionHead.directory
   * is derived from the first user record's `cwd`, which is the actual working
   * directory at session start. For worktree sessions this is the worktree
   * path, not the main repo root — `claude --resume` must be invoked from
   * there to find the same context. project_identity.path_root would route a
   * worktree session back to the wrong dir.
   */
  directory?: string | null;
  className?: string;
}

async function writeToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback (e.g. insecure context where the
      // Clipboard API is unavailable).
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

export function CopyResumeButton({
  sessionId,
  directory,
  className = "",
}: CopyResumeButtonProps) {
  const [copied, setCopied] = useState(false);
  const command = buildResumeCommand({ sessionId, directory });

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
      aria-label={
        copied
          ? `Resume command copied: ${command}`
          : `Copy claude --resume command: ${command}`
      }
      title={copied ? `Copied: ${command}` : `Copy: ${command}`}
      className={`console-mono inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] transition-colors ${className} ${
        copied
          ? "border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] text-[var(--console-text)]"
          : "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:border-[var(--console-border-strong)] hover:text-[var(--console-text)]"
      }`}
    >
      {copied ? (
        <Check className="size-3" strokeWidth={1.8} />
      ) : (
        <Copy className="size-3" strokeWidth={1.8} />
      )}
      <span>{copied ? "Copied" : "Copy resume"}</span>
    </button>
  );
}
