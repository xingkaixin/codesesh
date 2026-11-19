import { useState } from "react";
import { Link } from "react-router-dom";
import type { SessionHead } from "@codesesh/contract";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { formatInt, formatRelativeTime } from "../../lib/format";
import { getSessionReferenceKey, getSessionRoutePath } from "../../lib/session-indexes";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { ArrowUpRight, ChevronDown, ChevronUp, GitBranch } from "../ui/icons";

export function SessionSubSessions({ childSessions }: { childSessions: SessionHead[] }) {
  useLocale();
  const [expanded, setExpanded] = useState(true);

  if (childSessions.length === 0) return null;

  return (
    <section
      aria-label={t("Sub-sessions")}
      className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[var(--shadow-raised)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full items-center justify-between gap-3 px-[18px] py-2 text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--console-text)]">
          <GitBranch aria-hidden="true" className="size-4 text-[var(--console-muted)]" />
          {t("Sub-sessions")}
          <span className="console-mono inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-1.5 text-[11px] font-medium text-[var(--console-muted)]">
            {formatInt(childSessions.length)}
          </span>
        </span>
        {expanded ? (
          <ChevronUp aria-hidden="true" className="size-3.5 text-[var(--console-muted)]" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3.5 text-[var(--console-muted)]" />
        )}
      </button>
      {expanded ? (
        <ul className="divide-y divide-[var(--console-border)] border-t border-[var(--console-border)]">
          {childSessions.map((child) => {
            const updated = child.time_updated || child.time_created;
            return (
              <li key={getSessionReferenceKey(child)}>
                <Link
                  to={getSessionRoutePath(child)}
                  className="motion-hover flex items-center justify-between gap-4 px-[18px] py-2.5 text-sm text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none focus-visible:ring-inset"
                >
                  <span className="min-w-0 truncate font-medium">
                    {getSessionDisplayTitle(child)}
                  </span>
                  <span className="console-mono flex shrink-0 items-center gap-2 text-xs text-[var(--console-muted)]">
                    <span>{t("{0} messages", [formatInt(child.stats.message_count)])}</span>
                    {updated ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeTime(updated)}</span>
                      </>
                    ) : null}
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
