import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Check, Copy } from "./ui/icons";
import { useEffect, useState } from "react";
import { buildResumeCommand } from "../lib/build-resume-command";
import { writeToClipboard } from "../lib/clipboard";

interface CopyResumeButtonProps {
  /** Session ID, will be shell-quoted into the resume command. */
  sessionId: string;
  resumeCommandPrefix: string | null;
  /**
   * Session directory — pass `session.directory` from SessionHead.
   *
   * Why this field specifically: SessionHead.directory is the actual working
   * directory at session start. For worktree sessions this is the worktree
   * path, not the main repo root, so resume must be invoked from there to find
   * the same context.
   */
  directory?: string | null;
  className?: string;
}

export function CopyResumeButton({
  resumeCommandPrefix,
  sessionId,
  directory,
  className = "",
}: CopyResumeButtonProps) {
  useLocale();

  const [copied, setCopied] = useState(false);
  const command = buildResumeCommand({ resumeCommandPrefix, sessionId, directory });

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!command) return null;

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
          ? t("Resume command copied: {0}", [command])
          : t("Copy resume command: {0}", [command])
      }
      title={copied ? t("Copied: {0}", [command]) : t("Copy: {0}", [command])}
      className={`console-mono motion-hover motion-press inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none ${className} ${
        copied
          ? "border-[var(--positive)] bg-[var(--positive-soft)] text-[var(--positive)]"
          : "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:border-[var(--console-border-strong)] hover:text-[var(--console-text)]"
      }`}
    >
      {copied ? (
        <Check className="size-3" strokeWidth={1.8} />
      ) : (
        <Copy className="size-3" strokeWidth={1.8} />
      )}
      <span>{copied ? t("Copied") : t("Copy resume")}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? t("Resume command copied") : ""}
      </span>
    </button>
  );
}
