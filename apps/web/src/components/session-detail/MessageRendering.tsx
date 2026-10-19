import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { memo, useMemo, useState } from "react";
import {
  Bot,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Lightbulb,
  LoaderCircle,
  MessageCircleX,
  UserRound,
  XCircle,
} from "../ui/icons";
import type {
  AgentInfo,
  Message,
  PlanPart,
  ReasoningPart,
  ToolPart,
  SessionHead,
} from "@codesesh/contract";
import { formatMessageDate, formatMessageTime } from "../../lib/format";
import { getSessionRoutePath } from "../../lib/session-indexes";
import { buildHighlightPattern } from "../../lib/search-highlight";
import { AgentIcon } from "../AgentIcon";
import { MarkdownContent } from "../MarkdownContent";
import { ProgressiveText } from "../ProgressiveContent";
import { ToolOutputRenderer } from "../tool-output/ToolOutputRenderer";
import { Collapsible } from "../ui/collapsible";
import { Link } from "react-router-dom";
import type { MessageBlock } from "./blocks";
import { isCodexTurnAbortedMessage } from "./codex-abort";
import { buildCodexPlanDisplay } from "./codex-plan";
import { getDisplayTextWithRelativePaths } from "./path-extract";
import { buildBlockTimelineAnchorId, buildMessageTimelineAnchorId } from "./timeline";
import { useTimelineAnchorRef } from "./TimelineAnchorRegistry";
import { INITIAL_CONTENT_RENDER_BUDGETS } from "../../lib/content-render-budget";
import {
  type ToolStatus,
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeToolState,
} from "./tool-strategy";

const STATUS_CHIP_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap";

const TOOL_STATUS_META: Record<
  ToolStatus,
  { label: string; className: string; icon: typeof LoaderCircle }
> = {
  unknown: {
    label: "Unknown",
    className: "bg-[var(--console-surface-muted)] text-[var(--console-muted)]",
    icon: CircleHelp,
  },
  completed: {
    label: "Success",
    className: "bg-[var(--positive-soft)] text-[var(--positive)]",
    icon: CheckCircle2,
  },
  error: {
    label: "Failed",
    className: "bg-[var(--console-error-bg)] text-[var(--console-error)]",
    icon: XCircle,
  },
  running: {
    label: "Running",
    className: "bg-[var(--console-warning-bg)] text-[var(--console-warning)]",
    icon: LoaderCircle,
  },
};

function renderHighlightedText(text: string, query?: string) {
  const pattern = buildHighlightPattern(query);
  if (!pattern) return text;

  const parts = text.split(pattern);
  return parts.map((part, index) =>
    part.match(pattern) ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

function MessageMarkdown({ text, highlightQuery }: { text: string; highlightQuery?: string }) {
  useLocale();

  return <MarkdownContent text={text} highlightQuery={highlightQuery} />;
}

export const MessageItem = memo(function MessageItem({
  messageIndex,
  previousMessageTime,
  msg,
  blocks,
  formatTokens: fmtTokens,
  sessionAgentKey,
  agent,
  baseDirectory,
  highlightQuery,
  childSessionById,
}: {
  messageIndex: number;
  previousMessageTime?: Message["time_created"];
  msg: Message;
  blocks: MessageBlock[];
  formatTokens: (n: number) => string;
  sessionAgentKey: string;
  agent?: AgentInfo;
  baseDirectory: string;
  highlightQuery?: string;
  childSessionById?: ReadonlyMap<string, SessionHead>;
}) {
  useLocale();

  const isUser = msg.role === "user";
  const isAbortMessage = isCodexTurnAbortedMessage(msg, sessionAgentKey);
  const messageAnchorId = isUser ? buildMessageTimelineAnchorId(messageIndex) : undefined;
  const messageAnchorRef = useTimelineAnchorRef(messageAnchorId);

  const getAgentAvatar = () => {
    const agentName = agent?.displayName ?? sessionAgentKey;
    const agentIcon = agent?.icon;
    return (
      <>
        {agentIcon ? (
          <AgentIcon
            icon={agentIcon}
            iconColored={agent?.iconColored}
            alt={agentName}
            className="size-4 rounded-sm object-cover"
          />
        ) : (
          <Bot className="size-4 text-[var(--console-muted)]" />
        )}
      </>
    );
  };

  const modeLabel = msg.mode ? msg.mode.toUpperCase() : null;
  const modelLabel = msg.model || null;
  const roleLabel = getAssistantDisplayLabel(msg);
  const time = formatMessageTime(msg.time_created);
  const date = formatMessageDate(msg.time_created);
  const startsDay = date !== null && date !== formatMessageDate(previousMessageTime);
  const childSession = msg.subagent_id ? childSessionById?.get(msg.subagent_id) : undefined;

  return (
    <div data-message-id={msg.id}>
      {startsDay ? (
        <p className="console-mono mb-5 flex items-center gap-3 text-[11px] text-[var(--console-muted)] before:h-px before:flex-1 before:bg-[var(--console-border)] after:h-px after:flex-1 after:bg-[var(--console-border)]">
          {date}
        </p>
      ) : null}
      <article
        ref={messageAnchorRef}
        id={messageAnchorId}
        className="relative grid w-full scroll-mt-20 grid-cols-[28px_minmax(0,1fr)] gap-x-3.5 pb-[22px] before:absolute before:top-[34px] before:bottom-1.5 before:left-[13.5px] before:w-px before:bg-[var(--console-border)]"
      >
        <span
          className={
            isUser
              ? "flex size-7 items-center justify-center rounded-full bg-[var(--console-text)] text-[var(--console-surface)]"
              : "flex size-7 items-center justify-center rounded-full bg-[var(--console-surface)] text-[var(--console-muted)] shadow-[0_0_0_1px_var(--console-border)]"
          }
        >
          {isUser ? <UserRound className="size-3.5" /> : getAgentAvatar()}
        </span>
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex min-h-7 flex-wrap items-center gap-2 text-xs text-[var(--console-muted)]">
            <span className="text-[13px] font-semibold text-[var(--console-text)]">
              {roleLabel}
            </span>
            {time ? (
              <time className="console-mono whitespace-nowrap text-[11px]">{time}</time>
            ) : null}
            {modeLabel && (
              <span className="inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[10px] text-[var(--console-muted)] font-semibold tracking-[0.05em]">
                {modeLabel}
              </span>
            )}
            {modelLabel && (
              <span className="console-mono inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[10px] text-[var(--console-muted)] font-medium">
                {modelLabel}
              </span>
            )}
            {childSession ? (
              <Link
                to={getSessionRoutePath(childSession)}
                className="ml-auto text-xs text-[var(--brand)] hover:text-[var(--brand-hover)] hover:underline"
              >
                {t("Open sub-session ↗")}
              </Link>
            ) : null}
          </div>

          {isAbortMessage ? (
            <AbortToolItem />
          ) : (
            blocks.map((block, index) => {
              const timelineAnchorId = buildBlockTimelineAnchorId(messageIndex, index);
              if (block.type === "reasoning") {
                return (
                  <ReasoningSection
                    key={index}
                    anchorId={timelineAnchorId}
                    parts={block.parts}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              if (block.type === "plan") {
                return (
                  <PlansSection
                    key={index}
                    anchorId={timelineAnchorId}
                    parts={block.parts}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              if (block.type === "tool") {
                return (
                  <ToolsSection
                    key={index}
                    parts={block.parts}
                    anchorIds={block.anchorIds}
                    sessionAgentKey={sessionAgentKey}
                    baseDirectory={baseDirectory}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              return (
                <MessageTextSection
                  key={index}
                  anchorId={timelineAnchorId}
                  parts={block.parts}
                  highlightQuery={highlightQuery}
                  bubble={isUser}
                />
              );
            })
          )}

          {!isUser && (msg.tokens || msg.cost) && (
            <div className="flex flex-wrap gap-1.5">
              {msg.tokens?.input ? (
                <span className="console-mono inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[10px] text-[var(--console-muted)] font-medium">
                  {t("INPUT")} {fmtTokens(msg.tokens.input)}
                </span>
              ) : null}
              {msg.tokens?.output ? (
                <span className="console-mono inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[10px] text-[var(--console-muted)] font-medium">
                  {t("OUTPUT")} {fmtTokens(msg.tokens.output)}
                </span>
              ) : null}
              {msg.tokens?.reasoning ? (
                <span className="console-mono inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[10px] text-[var(--console-muted)] font-medium">
                  {t("REASONING")} {fmtTokens(msg.tokens.reasoning)}
                </span>
              ) : null}
              {msg.cost ? (
                <span className="console-mono inline-flex h-5 items-center rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[10px] text-[var(--console-muted)] font-medium">
                  {msg.cost_source === "estimated" ? t("EST COST") : t("COST")} $
                  {msg.cost.toFixed(4)}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </article>
    </div>
  );
});

const MessageTextSection = memo(function MessageTextSection({
  anchorId,
  parts,
  highlightQuery,
  bubble,
}: {
  anchorId: string;
  parts: Array<{ text: string }>;
  highlightQuery?: string;
  bubble: boolean;
}) {
  useLocale();

  const anchorRef = useTimelineAnchorRef(anchorId);

  return (
    <div
      ref={anchorRef}
      id={anchorId}
      className={
        bubble
          ? "max-w-[760px] scroll-mt-20 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] px-4 py-3 shadow-[var(--shadow-raised)]"
          : "max-w-[760px] scroll-mt-20"
      }
    >
      <div className="console-markdown text-[13px] leading-[1.75] text-[var(--console-text)]">
        {parts.map((part, index) => (
          <MessageMarkdown key={index} text={part.text} highlightQuery={highlightQuery} />
        ))}
      </div>
    </div>
  );
});

function AbortToolItem() {
  useLocale();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-full rounded-lg border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-2 text-left shadow-[var(--shadow-raised)] md:w-[560px]">
          <div className="flex items-start gap-2">
            <MessageCircleX className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
            <span className="min-w-0 flex-1">
              <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                {t("abort")}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const ReasoningSection = memo(function ReasoningSection({
  anchorId,
  parts,
  highlightQuery,
}: {
  anchorId: string;
  parts: ReasoningPart[];
  highlightQuery?: string;
}) {
  useLocale();

  const [expanded, setExpanded] = useState(false);
  const anchorRef = useTimelineAnchorRef(anchorId);
  const fullText = useMemo(
    () =>
      parts
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n"),
    [parts],
  );

  return (
    <div ref={anchorRef} id={anchorId} className="max-w-[760px] scroll-mt-20">
      <button
        type="button"
        className="motion-hover inline-flex h-8 items-center gap-2 rounded-lg border border-dashed border-[var(--console-border-strong)] px-3 text-xs text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        onClick={() => setExpanded((isExpanded) => !isExpanded)}
        aria-expanded={expanded}
      >
        <Lightbulb className="size-3.5" />
        {t("Thinking")}
        <ChevronDown className="motion-chevron size-3.5" data-open={expanded || undefined} />
      </button>
      <Collapsible open={expanded}>
        {() => (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--console-border-strong)] px-4 py-3">
            <ProgressiveText text={fullText} initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}>
              {(visibleText) => (
                <div className="console-mono whitespace-pre-wrap text-xs leading-relaxed text-[var(--console-muted)]">
                  {renderHighlightedText(visibleText, highlightQuery)}
                </div>
              )}
            </ProgressiveText>
          </div>
        )}
      </Collapsible>
    </div>
  );
});

const ToolsSection = memo(function ToolsSection({
  parts,
  anchorIds,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  parts: ToolPart[];
  anchorIds?: string[];
  sessionAgentKey: string;
  baseDirectory: string;
  highlightQuery?: string;
}) {
  useLocale();

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {parts.map((tool, index) => (
          <ToolItem
            key={index}
            tool={tool}
            anchorId={anchorIds?.[index]}
            sessionAgentKey={sessionAgentKey}
            baseDirectory={baseDirectory}
            highlightQuery={highlightQuery}
          />
        ))}
      </div>
    </div>
  );
});

const PlansSection = memo(function PlansSection({
  anchorId,
  parts,
  highlightQuery,
}: {
  anchorId: string;
  parts: PlanPart[];
  highlightQuery?: string;
}) {
  useLocale();

  const anchorRef = useTimelineAnchorRef(anchorId);

  return (
    <div ref={anchorRef} id={anchorId} className="scroll-mt-20 space-y-2">
      {parts.map((plan, i) => (
        <PlanItem key={i} part={plan} highlightQuery={highlightQuery} />
      ))}
    </div>
  );
});

const PlanItem = memo(function PlanItem({
  part,
  highlightQuery,
}: {
  part: PlanPart;
  highlightQuery?: string;
}) {
  const locale = useLocale();

  const [expanded, setExpanded] = useState(false);
  const display = useMemo(
    () => buildCodexPlanDisplay(part),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, part],
  );
  const statusMeta =
    display.approvalStatus === "fail" ? TOOL_STATUS_META.error : TOOL_STATUS_META.completed;
  const StatusIcon = statusMeta.icon;
  const title = (
    <>
      <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--console-surface-muted)] text-[var(--console-text-secondary)]">
        <CalendarRange className="size-3.5" />
      </span>
      <span className="console-mono min-w-0 flex-1 truncate text-xs font-medium text-[var(--console-text)]">
        {t(display.title)}
      </span>
    </>
  );

  return (
    <div className="max-w-[760px] overflow-hidden rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[var(--shadow-raised)]">
      <div className="flex min-h-10 items-center gap-2.5 py-2 pr-2.5 pl-3">
        {display.expandable ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
            onClick={() => setExpanded((isExpanded) => !isExpanded)}
            aria-expanded={expanded}
          >
            {title}
            <ChevronDown
              className="motion-chevron size-3.5 shrink-0 text-[var(--console-muted)]"
              data-open={expanded || undefined}
            />
          </button>
        ) : (
          title
        )}
        <span className={`${STATUS_CHIP_CLASS} ${statusMeta.className}`}>
          <StatusIcon className="size-3" />
          {t(statusMeta.label)}
        </span>
      </div>

      <Collapsible open={display.expandable && expanded}>
        {() => (
          <div className="space-y-2 border-t border-[var(--console-border)] bg-[var(--console-bg)] p-3">
            <span className="block text-[11px] font-medium text-[var(--console-muted)]">
              {display.contentLabel}
            </span>
            <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
              <MessageMarkdown text={display.contentMarkdown} highlightQuery={highlightQuery} />
            </div>
          </div>
        )}
      </Collapsible>
    </div>
  );
});

const ToolItem = memo(function ToolItem({
  tool,
  anchorId,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  tool: ToolPart;
  anchorId?: string;
  sessionAgentKey: string;
  baseDirectory?: string;
  highlightQuery?: string;
}) {
  const locale = useLocale();

  const [expanded, setExpanded] = useState(false);
  const anchorRef = useTimelineAnchorRef(anchorId);
  const state = useMemo(() => normalizeToolState(tool), [tool]);
  const strategy = useMemo(
    () => getToolDisplayStrategy(sessionAgentKey, tool, state, baseDirectory),

    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, baseDirectory, sessionAgentKey, state, tool],
  );
  const inputPreviewText = useMemo(
    () => getDisplayTextWithRelativePaths(state.inputText || "{}", baseDirectory),
    [baseDirectory, state.inputText],
  );
  const statusMeta = TOOL_STATUS_META[state.status];
  const StatusIcon = statusMeta.icon;
  const ToolIcon = strategy.Icon;
  const header = (
    <>
      <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--console-surface-muted)] text-[var(--console-text-secondary)]">
        <ToolIcon className="size-3.5" />
      </span>
      <span className="console-mono shrink-0 text-xs font-medium text-[var(--console-text)]">
        {strategy.title}
      </span>
      <span
        className="console-mono min-w-0 flex-1 truncate text-[11px] text-[var(--console-muted)]"
        title={strategy.secondaryText ?? undefined}
      >
        {strategy.secondaryText
          ? renderHighlightedText(strategy.secondaryText, highlightQuery)
          : null}
      </span>
      <span className={`${STATUS_CHIP_CLASS} ${statusMeta.className}`}>
        <StatusIcon
          className={`size-3 ${state.status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
        {t(statusMeta.label)}
      </span>
    </>
  );

  return (
    <div
      ref={anchorRef}
      id={anchorId}
      className="max-w-[760px] scroll-mt-20 overflow-hidden rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[var(--shadow-raised)]"
    >
      {strategy.expandable ? (
        <button
          type="button"
          className="motion-hover flex min-h-10 w-full items-center gap-2.5 py-2 pr-2.5 pl-3 text-left hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none focus-visible:ring-inset"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {header}
          <ChevronDown
            className="motion-chevron size-3.5 shrink-0 text-[var(--console-muted)]"
            data-open={expanded || undefined}
          />
        </button>
      ) : (
        <div className="flex min-h-10 items-center gap-2.5 py-2 pr-2.5 pl-3">{header}</div>
      )}

      <Collapsible open={strategy.expandable && expanded}>
        {() => (
          <div className="border-t border-[var(--console-border)] bg-[var(--console-bg)]">
            <div className="space-y-2 p-3">
              <span className="block text-[11px] font-medium text-[var(--console-muted)]">
                {strategy.contentLabel ?? t("Output")}
              </span>
              {strategy.details.length > 0 ? (
                <div className="rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2">
                  <div className="space-y-2">
                    {strategy.details.map((detail) => (
                      <div
                        key={`${detail.label}:${detail.value}`}
                        className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3"
                      >
                        <span className="console-mono shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--console-muted)] md:w-24">
                          {detail.label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <ProgressiveText
                            text={detail.value}
                            initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}
                          >
                            {(visibleText) => (
                              <span className="console-mono whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-text)]">
                                {renderHighlightedText(visibleText, highlightQuery)}
                              </span>
                            )}
                          </ProgressiveText>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <ToolOutputRenderer outputContent={strategy.outputContent} />
            </div>
            {strategy.showInputPreview ? (
              <div className="border-t border-[var(--console-border)] px-3 py-2">
                <span className="console-mono text-[11px] text-[var(--console-muted)]">
                  {t("Input Preview")}
                </span>
                <ProgressiveText
                  text={inputPreviewText}
                  initialBudget={INITIAL_CONTENT_RENDER_BUDGETS.plain}
                >
                  {(visibleText) => (
                    <pre className="console-mono mt-1 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                      {renderHighlightedText(visibleText, highlightQuery)}
                    </pre>
                  )}
                </ProgressiveText>
              </div>
            ) : null}
          </div>
        )}
      </Collapsible>
    </div>
  );
});
