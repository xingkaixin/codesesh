import { useState, type ReactNode } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { formatMessageDate, formatMessageTime } from "../../lib/format";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";
import { MarkdownContent } from "../MarkdownContent";
import { ProgressiveText } from "../ProgressiveContent";
import { toDisplayText, toPlainText, toRecord } from "../session-detail/tool-normalize";
import { PropertyListOutput } from "./PropertyListOutput";
import type { ThreadReadToolOutputContent } from "./types";

function ExcerptDetails({
  label,
  children,
  initiallyOpen = false,
}: {
  label: string;
  children: ReactNode;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0"
    >
      <summary className="cursor-pointer rounded-sm py-2 text-xs font-semibold text-[var(--console-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
        {label}
      </summary>
      {open ? children : null}
    </details>
  );
}

function RawExcerpt({ value }: { value: unknown }) {
  return (
    <ProgressiveText
      text={toDisplayText(value)}
      initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}
    >
      {(text) => (
        <pre className="console-mono max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-text)]">
          {text}
        </pre>
      )}
    </ProgressiveText>
  );
}

function ExcerptItem({ item }: { item: Record<string, unknown> }) {
  const type = toPlainText(item.type);
  const isUser = type === "userMessage";
  const isAgent = type === "agentMessage";
  const rawText = isUser
    ? (Array.isArray(item.content) ? item.content : [])
        .map((part) => toPlainText(toRecord(part).text))
        .filter(Boolean)
        .join("\n")
    : toPlainText(item.text);
  const text = isUser
    ? rawText
        .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, "")
        .trim()
    : rawText;
  const label = isUser
    ? t("User")
    : isAgent
      ? item.phase === "final_answer"
        ? t("Final reply")
        : t("Progress update")
      : type === "reasoning"
        ? t("Reasoning")
        : toPlainText(item.tool) || toPlainText(item.command).slice(0, 100) || type;
  return (
    <ExcerptDetails
      label={label}
      initiallyOpen={isUser || (isAgent && item.phase === "final_answer")}
    >
      {text ? (
        <div className="console-markdown break-words pb-3 text-sm leading-relaxed text-[var(--console-text)]">
          <MarkdownContent text={text} />
        </div>
      ) : (
        <RawExcerpt value={item} />
      )}
    </ExcerptDetails>
  );
}

export function ThreadReadOutput({ content }: { content: ThreadReadToolOutputContent }) {
  useLocale();
  const [expanded, setExpanded] = useState<{
    source: ThreadReadToolOutputContent;
    count: number;
  } | null>(null);
  const count = expanded?.source === content ? expanded.count : 5;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--console-text)]">{content.title}</span>
        <span className="console-mono text-xs text-[var(--console-muted)]">
          {t("{0} turns", [content.turns.length])}
          {content.newestFirst ? ` · ${t("Newest first")}` : ""}
        </span>
      </div>
      {content.turns.length === 0 ? (
        <p className="text-sm text-[var(--console-muted)]">{t("No turns recorded")}</p>
      ) : null}
      {content.turns.slice(0, count).map((turn, index) => {
        const isReply = (item: Record<string, unknown>) =>
          item.type === "userMessage" ||
          (item.type === "agentMessage" && item.phase === "final_answer");
        const replies = turn.items.filter(isReply);
        const activity = turn.items.filter((item) => !isReply(item));
        const date = turn.startedAt
          ? `${formatMessageDate(turn.startedAt * 1000)} ${formatMessageTime(turn.startedAt * 1000)}`
          : t("Turn {0}", [index + 1]);
        const status =
          turn.status === "completed"
            ? t("Done")
            : turn.status === "failed"
              ? t("Failed")
              : turn.status === "inProgress"
                ? t("In progress")
                : turn.status;
        return (
          <section
            key={turn.id}
            className="min-w-0 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--console-border)] px-3 py-2 text-xs text-[var(--console-muted)]">
              <span>{date}</span>
              <span className={turn.status === "failed" ? "text-[var(--console-error)]" : ""}>
                {status}
              </span>
            </div>
            <div className="divide-y divide-[var(--console-border)] px-3">
              {turn.items.length === 0 ? (
                <p className="py-3 text-xs text-[var(--console-muted)]">
                  {t("No messages recorded")}
                </p>
              ) : null}
              {replies.map((item, itemIndex) => (
                <ExcerptItem key={toPlainText(item.id) || itemIndex} item={item} />
              ))}
              {activity.length > 0 ? (
                <ExcerptDetails label={t("Other activity ({0})", [activity.length])}>
                  {activity.map((item, itemIndex) => (
                    <ExcerptItem key={toPlainText(item.id) || itemIndex} item={item} />
                  ))}
                </ExcerptDetails>
              ) : null}
              {turn.error ? (
                <div className="py-3">
                  <RawExcerpt value={turn.error} />
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
      {count < content.turns.length ? (
        <button
          type="button"
          onClick={() => setExpanded({ source: content, count: count + 5 })}
          className="rounded-sm border border-[var(--console-border)] px-3 py-2 text-xs font-semibold text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          {t("Show more turns")}
        </button>
      ) : null}
      {content.hasMore ? (
        <p className="text-xs text-[var(--console-muted)]">
          {t("Earlier turns exist outside this tool result")}
        </p>
      ) : null}
      <div className="border-t border-[var(--console-border)] pt-1">
        <ExcerptDetails label={t("Request details")}>
          <PropertyListOutput
            items={[{ label: t("Session"), value: content.threadId }, ...content.request]}
          />
        </ExcerptDetails>
        <ExcerptDetails label={t("Raw output")}>
          <RawExcerpt value={content.rawOutput} />
        </ExcerptDetails>
      </div>
    </div>
  );
}
