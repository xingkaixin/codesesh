import { useState } from "react";
import {
  Bot,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  LoaderCircle,
  MessageCircleX,
  UserRound,
  XCircle,
} from "lucide-react";
import type { AgentInfo, Message, MessagePart } from "../../lib/api";
import { formatMessageTime } from "../../lib/format";
import { MarkdownContent } from "../MarkdownContent";
import { ToolOutputRenderer } from "../tool-output/ToolOutputRenderer";
import { extractMessageText, type MessageBlock } from "./blocks";
import { isCodexTurnAbortedMessage } from "./codex-abort";
import { buildCodexPlanDisplay } from "./codex-plan";
import { getDisplayTextWithRelativePaths } from "./path-extract";
import { buildBlockTimelineAnchorId, buildMessageTimelineAnchorId } from "./timeline";
import { escapeRegExp } from "./utils";
import {
  type ToolStatus,
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeToolState,
} from "./tool-strategy";

const TOOL_STATUS_META: Record<
  ToolStatus,
  { label: string; className: string; icon: typeof LoaderCircle }
> = {
  completed: {
    label: "Success",
    className:
      "border-[var(--console-success-border)] bg-[var(--console-success-bg)] text-[var(--console-success)]",
    icon: CheckCircle2,
  },
  error: {
    label: "Failed",
    className:
      "border-[var(--console-error-border)] bg-[var(--console-error-bg)] text-[var(--console-error)]",
    icon: XCircle,
  },
  running: {
    label: "Running",
    className:
      "border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] text-[var(--console-warning)]",
    icon: LoaderCircle,
  },
};

function buildHighlightPattern(query?: string): RegExp | null {
  const normalized = query?.trim();
  if (!normalized) return null;
  const terms = Array.from(
    new Set(
      (normalized.match(/"[^"]+"|\S+/g) ?? [])
        .map((term) => term.replace(/^"|"$/g, "").trim())
        .filter(Boolean)
        .filter((term) => !/^OR$/i.test(term)),
    ),
  );
  if (terms.length === 0) return null;
  return new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
}

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
  return <MarkdownContent text={text} highlightQuery={highlightQuery} />;
}

export function MessageItem({
  messageIndex,
  msg,
  blocks,
  toolAnchorIds,
  formatTokens: fmtTokens,
  sessionAgentKey,
  agent,
  baseDirectory,
  highlightQuery,
}: {
  messageIndex: number;
  msg: Message;
  blocks: MessageBlock[];
  toolAnchorIds: Map<MessagePart, string>;
  formatTokens: (n: number) => string;
  sessionAgentKey: string;
  agent?: AgentInfo;
  baseDirectory: string;
  highlightQuery?: string;
}) {
  const isUser = msg.role === "user";
  const isAbortMessage = isCodexTurnAbortedMessage(msg, sessionAgentKey);

  const getAgentAvatar = () => {
    const agentName = agent?.displayName ?? sessionAgentKey;
    const agentIcon = agent?.icon;
    return (
      <>
        {agentIcon ? (
          <img src={agentIcon} alt={agentName} className="size-4 rounded-sm object-cover" />
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

  return (
    <article
      id={isUser ? buildMessageTimelineAnchorId(messageIndex) : undefined}
      data-session-timeline-anchor={isUser ? buildMessageTimelineAnchorId(messageIndex) : undefined}
      className="w-full scroll-mt-20 border-l-2 border-[var(--console-thread)] pl-4 pr-3 md:pr-5"
    >
      <div className="flex gap-4">
        <div className="shrink-0 pt-1">
          <div className="flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
            {isUser ? (
              <UserRound className="size-4 text-[var(--console-muted)]" />
            ) : (
              getAgentAvatar()
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="console-mono text-sm font-bold tracking-wide text-[var(--console-text)]">
              {roleLabel}
            </span>
            <time className="console-mono text-xs text-[var(--console-muted)]">{time}</time>
            {modeLabel && (
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                {modeLabel}
              </span>
            )}
            {modelLabel && (
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                {modelLabel}
              </span>
            )}
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
                    toolAnchorIds={toolAnchorIds}
                    sessionAgentKey={sessionAgentKey}
                    baseDirectory={baseDirectory}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              return (
                <div
                  key={index}
                  id={timelineAnchorId}
                  data-session-timeline-anchor={timelineAnchorId}
                  className="scroll-mt-20 rounded-sm border border-[var(--console-border)] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                >
                  <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
                    {block.parts.map((part, partIndex) => (
                      <MessageMarkdown
                        key={partIndex}
                        text={extractMessageText(part.text)}
                        highlightQuery={highlightQuery}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}

          {!isUser && (msg.tokens || msg.cost) && (
            <div className="flex flex-wrap gap-2">
              {msg.tokens?.input ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  INPUT {fmtTokens(msg.tokens.input)}
                </span>
              ) : null}
              {msg.tokens?.output ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  OUTPUT {fmtTokens(msg.tokens.output)}
                </span>
              ) : null}
              {msg.tokens?.reasoning ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  REASONING {fmtTokens(msg.tokens.reasoning)}
                </span>
              ) : null}
              {msg.cost ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  {msg.cost_source === "estimated" ? "EST COST" : "COST"} ${msg.cost.toFixed(4)}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function AbortToolItem() {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-full rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] md:w-[560px]">
          <div className="flex items-start gap-2">
            <MessageCircleX className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
            <span className="min-w-0 flex-1">
              <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                abort
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReasoningSection({
  anchorId,
  parts,
  highlightQuery,
}: {
  anchorId: string;
  parts: MessagePart[];
  highlightQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fullText = parts
    .map((p) => extractMessageText(p.text))
    .filter(Boolean)
    .join("\n\n");

  return (
    <div
      id={anchorId}
      data-session-timeline-anchor={anchorId}
      className="scroll-mt-20 overflow-hidden rounded-sm border border-[var(--console-thinking-border)] bg-[var(--console-thinking-bg)]"
    >
      <div
        className="flex cursor-pointer items-center justify-between bg-[var(--console-surface-muted)] px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="console-mono flex items-center gap-2 text-xs font-medium text-[var(--console-muted)]">
          <Lightbulb className="size-3.5" />
          Thinking
        </span>
        <span className="text-[var(--console-muted)]">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-dashed border-[var(--console-thinking-border)] px-4 py-3">
          <div className="console-mono whitespace-pre-wrap text-xs leading-relaxed text-[var(--console-muted)]">
            {renderHighlightedText(fullText, highlightQuery)}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolsSection({
  parts,
  toolAnchorIds,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  parts: MessagePart[];
  toolAnchorIds: Map<MessagePart, string>;
  sessionAgentKey: string;
  baseDirectory: string;
  highlightQuery?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {parts.map((tool, i) => (
          <ToolItem
            key={i}
            tool={tool}
            anchorId={toolAnchorIds.get(tool)}
            sessionAgentKey={sessionAgentKey}
            baseDirectory={baseDirectory}
            highlightQuery={highlightQuery}
          />
        ))}
      </div>
    </div>
  );
}

function PlansSection({
  anchorId,
  parts,
  highlightQuery,
}: {
  anchorId: string;
  parts: MessagePart[];
  highlightQuery?: string;
}) {
  return (
    <div id={anchorId} data-session-timeline-anchor={anchorId} className="scroll-mt-20 space-y-2">
      {parts.map((plan, i) => (
        <PlanItem key={i} part={plan} highlightQuery={highlightQuery} />
      ))}
    </div>
  );
}

function PlanItem({ part, highlightQuery }: { part: MessagePart; highlightQuery?: string }) {
  const [expanded, setExpanded] = useState(false);
  const display = buildCodexPlanDisplay(part);
  const statusMeta =
    display.approvalStatus === "fail" ? TOOL_STATUS_META.error : TOOL_STATUS_META.completed;
  const StatusIcon = statusMeta.icon;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={`w-full md:w-[560px] rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] ${
            display.expandable ? "transition-colors hover:bg-[var(--console-surface-muted)]" : ""
          }`}
        >
          {display.expandable ? (
            <button
              type="button"
              className="flex w-full items-start gap-2 text-left"
              onClick={() => setExpanded(!expanded)}
            >
              <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {display.title}
                </span>
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--console-muted)]">
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {display.title}
                </span>
              </span>
            </div>
          )}
        </div>
        <span
          className={`console-mono inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusMeta.className}`}
        >
          <StatusIcon className="size-3" />
          {statusMeta.label}
        </span>
      </div>

      {display.expandable && expanded ? (
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <span className="console-mono text-xs text-[var(--console-muted)]">
              {display.contentLabel}
            </span>
          </div>
          <div className="p-4">
            <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
              <MessageMarkdown text={display.contentMarkdown} highlightQuery={highlightQuery} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolItem({
  tool,
  anchorId,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  tool: MessagePart;
  anchorId?: string;
  sessionAgentKey: string;
  baseDirectory?: string;
  highlightQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const state = normalizeToolState(tool);
  const strategy = getToolDisplayStrategy(sessionAgentKey, tool, state, baseDirectory);
  const inputPreviewText = getDisplayTextWithRelativePaths(state.inputText || "{}", baseDirectory);
  const statusMeta = TOOL_STATUS_META[state.status];
  const StatusIcon = statusMeta.icon;
  const ToolIcon = strategy.Icon;

  return (
    <div id={anchorId} data-session-timeline-anchor={anchorId} className="scroll-mt-20 space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={`w-full max-w-[720px] rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2.5 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] ${
            strategy.expandable ? "transition-colors hover:bg-[var(--console-surface-muted)]" : ""
          }`}
        >
          {strategy.expandable ? (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 text-left active:scale-[0.995] motion-reduce:transform-none"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                <ToolIcon className="size-3.5 text-[var(--console-accent)]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {strategy.title}
                </span>
                {strategy.secondaryText ? (
                  <span className="console-mono mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                    {renderHighlightedText(strategy.secondaryText, highlightQuery)}
                  </span>
                ) : null}
              </span>
              <span
                className={`console-mono inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${statusMeta.className}`}
              >
                <StatusIcon
                  className={`size-2.5 ${state.status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
                />
                {statusMeta.label}
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--console-muted)]">
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          ) : (
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                <ToolIcon className="size-3.5 text-[var(--console-accent)]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {strategy.title}
                </span>
                {strategy.secondaryText ? (
                  <span className="console-mono mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                    {renderHighlightedText(strategy.secondaryText, highlightQuery)}
                  </span>
                ) : null}
              </span>
              <span
                className={`console-mono inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${statusMeta.className}`}
              >
                <StatusIcon className="size-2.5" />
                {statusMeta.label}
              </span>
            </div>
          )}
        </div>
      </div>

      {strategy.expandable && expanded ? (
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <span className="console-mono text-xs text-[var(--console-muted)]">
              {strategy.contentLabel ?? "Output"}
            </span>
          </div>
          <div className="space-y-3 p-3">
            {strategy.details.length > 0 ? (
              <div className="rounded-sm border border-[var(--console-border)] bg-[#fafafa] px-3 py-2">
                <div className="space-y-2">
                  {strategy.details.map((detail) => (
                    <div
                      key={`${detail.label}:${detail.value}`}
                      className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3"
                    >
                      <span className="console-mono shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--console-muted)] md:w-24">
                        {detail.label}
                      </span>
                      <span className="console-mono whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-text)]">
                        {renderHighlightedText(detail.value, highlightQuery)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <ToolOutputRenderer outputContent={strategy.outputContent} />
          </div>
          {strategy.showInputPreview ? (
            <div className="border-t border-[var(--console-border)] bg-[#fafafa] px-3 py-2">
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
                Input Preview
              </span>
              <pre className="console-mono mt-1 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                {renderHighlightedText(inputPreviewText, highlightQuery)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
