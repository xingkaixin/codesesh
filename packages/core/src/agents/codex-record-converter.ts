import type { MessagePart } from "../types/index.js";
import { cleanInternalText, isInternalEventType } from "../utils/session-normalization.js";
import { parseAgentTimestamp } from "../utils/timestamp.js";
import { asRecord, asString, narrowField } from "../utils/narrow.js";
import { TranscriptBuilder } from "./transcript-builder.js";
import { normalizeToolArguments } from "./tool-arguments.js";
import {
  type ExecInnerCall,
  decodeExecCalls,
  getExecPatchText,
  pickExecOutputTarget,
  splitExecToolName,
  stripExecOutputEnvelope,
} from "./codex-exec-decode.js";

const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/;
const PLAN_APPROVAL_PREFIX = "PLEASE IMPLEMENT THIS PLAN";
const SUBAGENT_NOTIFICATION_PATTERN =
  /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/;

const DEVELOPER_LIKE_USER_MARKERS = [
  "agents.md instructions for",
  "<instructions>",
  "<environment_context>",
  "<permissions instructions>",
  "<collaboration_mode>",
];

export function isDeveloperLikeUserMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return DEVELOPER_LIKE_USER_MARKERS.some((m) => lower.includes(m));
}

const CODEX_TOOL_TITLE_MAP: Record<string, string> = {
  exec_command: "bash",
  apply_patch: "patch",
  patch: "patch",
  spawn_agent: "subagent",
  subagent: "subagent",
};

export function parseCodexTimestampMs(data: Record<string, unknown>): number {
  return parseAgentTimestamp(data["timestamp"], "codex") ?? 0;
}

export function narrowRecordField(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  return narrowField("codex", field, value, asRecord);
}

export function extractCodexPayload(data: Record<string, unknown>): Record<string, unknown> {
  return narrowRecordField(data["payload"], "payload") ?? {};
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function resolveToolIdentity(
  name: string,
  namespace: unknown,
): { tool: string; metadata?: { name: string; namespace: string } } {
  const mappedName = CODEX_TOOL_TITLE_MAP[name];
  if (mappedName) return { tool: mappedName };

  const namespaceText = typeof namespace === "string" ? namespace.trim() : "";
  if (!namespaceText) return { tool: name };

  const namespaceName = namespaceText.split("__").at(-1) ?? namespaceText;
  const toolName = name.replace(/^[_.]+/, "");
  if (!namespaceName) {
    return {
      tool: toolName || name,
      metadata: { name, namespace: namespaceText },
    };
  }

  return {
    tool: `${namespaceName}.${toolName || name}`,
    metadata: { name, namespace: namespaceText },
  };
}

function normalizeCustomToolArguments(toolName: string, input: unknown): unknown {
  if (toolName === "apply_patch") {
    return parseApplyPatchInput(input);
  }
  return input;
}

/**
 * Flatten tool-call output to text. Classic outputs are strings; code-mode
 * outputs are arrays of `{ type: "input_text", text }` segments.
 */
function flattenOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === "string") return item;
        const record = asRecord(item);
        return record ? (asString(record["text"]) ?? "") : "";
      })
      .join("");
  }
  return "";
}

export function extractAssistantOutputText(payload: Record<string, unknown>): string {
  const content = payload["content"];
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item);
        return record && String(record["type"] ?? "") === "output_text"
          ? String(record["text"] ?? "")
          : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

interface PatchBlock {
  type: "write_file" | "delete_file" | "move_file" | "edit_file";
  path?: string;
  content?: string;
  targetPath?: string;
}

const PATCH_BEGIN_RE = /\*\*\* Begin Patch/;
const PATCH_END_RE = /\*\*\* End Patch/;
const PATCH_HEADER_RE = /\*\*\*\s+(Add|Delete|Update|Move)\s+File:\s*(.+)/;
const PATCH_MOVE_TO_RE = /\*\*\*\s+Move to:\s*(.+)/;

function parseApplyPatchInput(input: unknown): PatchBlock[] {
  const text = typeof input === "string" ? input : "";
  if (!text) return [];

  const blocks: PatchBlock[] = [];
  const lines = text.split("\n");
  let inPatch = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!inPatch && PATCH_BEGIN_RE.test(line)) {
      inPatch = true;
      i++;
      continue;
    }

    if (inPatch && PATCH_END_RE.test(line)) {
      inPatch = false;
      i++;
      continue;
    }

    if (inPatch) {
      const headerMatch = line.match(PATCH_HEADER_RE);
      if (headerMatch) {
        const action = headerMatch[1]!;
        const filePath = headerMatch[2]!.trim();
        i++;

        if (action === "Add") {
          const content = extractPatchContent(lines, i);
          i = content.nextLineIndex;
          blocks.push({ type: "write_file", path: filePath, content: content.text });
        } else if (action === "Update") {
          // Check for Move to on the next non-empty line
          let moveToTarget: string | null = null;
          let contentStart = i;
          for (let j = i; j < lines.length; j++) {
            const l = lines[j]!;
            if (!l.trim()) continue;
            const moveMatch = l.match(PATCH_MOVE_TO_RE);
            if (moveMatch) {
              moveToTarget = moveMatch[1]!.trim();
              contentStart = j + 1;
              break;
            }
            break;
          }
          if (moveToTarget) {
            const content = extractPatchContent(lines, contentStart);
            i = content.nextLineIndex;
            blocks.push({
              type: "move_file",
              path: filePath,
              targetPath: moveToTarget,
              content: content.text,
            });
          } else {
            const content = extractPatchContent(lines, i);
            i = content.nextLineIndex;
            blocks.push({ type: "edit_file", path: filePath, content: content.text });
          }
        } else if (action === "Delete") {
          blocks.push({ type: "delete_file", path: filePath });
          // No content to read for delete
        }
        continue;
      }
    }

    i++;
  }

  return blocks;
}

function extractPatchContent(
  lines: string[],
  startIndex: number,
): { text: string; nextLineIndex: number } {
  const contentLines: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i]!;
    // Stop at next patch header or end patch
    if (PATCH_HEADER_RE.test(line) || PATCH_END_RE.test(line)) break;
    contentLines.push(line);
    i++;
  }
  return { text: contentLines.join("\n"), nextLineIndex: i };
}

export class CodexRecordConverter {
  // ---- Record conversion ----

  convertRecord(
    data: Record<string, unknown>,
    transcript: TranscriptBuilder,
    pendingPlan: MessagePart | null,
    activeModel: string | null,
  ): MessagePart | null {
    const recordType = String(data["type"] ?? "");
    if (isInternalEventType(recordType)) return pendingPlan;

    if (recordType === "session_meta" || recordType === "event_msg") {
      return pendingPlan;
    }

    if (recordType !== "response_item") return pendingPlan;

    const payload = extractCodexPayload(data);
    const payloadType = String(payload["type"] ?? "");
    if (isInternalEventType(payloadType)) return pendingPlan;
    const timestampMs = parseCodexTimestampMs(data) || parseCodexTimestampMs(payload);

    switch (payloadType) {
      case "message": {
        const role = String(payload["role"] ?? "");
        if (role === "assistant") {
          return this.convertAssistantMessage(
            payload,
            transcript,
            timestampMs,
            pendingPlan,
            activeModel,
          );
        }
        if (role === "user") {
          return this.convertUserMessage(payload, transcript, timestampMs, pendingPlan);
        }
        break;
      }

      case "reasoning":
        this.convertReasoning(payload, transcript, timestampMs, activeModel);
        return null;

      case "function_call":
        this.convertFunctionCall(payload, transcript, timestampMs, activeModel);
        return null;

      case "function_call_output":
        this.convertToolCallOutput(payload, transcript, timestampMs);
        return pendingPlan;

      case "custom_tool_call":
        this.convertCustomToolCall(payload, transcript, timestampMs, activeModel);
        return null;

      case "custom_tool_call_output":
        this.convertToolCallOutput(payload, transcript, timestampMs);
        return pendingPlan;
    }

    return pendingPlan;
  }

  // ---- Assistant message ----

  private convertAssistantMessage(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    pendingPlan: MessagePart | null,
    activeModel: string | null,
  ): MessagePart | null {
    const fullText = extractAssistantOutputText(payload);
    if (!fullText) return pendingPlan;

    const planMatch = fullText.match(PROPOSED_PLAN_PATTERN);
    if (planMatch) {
      const planText = planMatch[1]!.trim();
      const planPart: MessagePart = {
        type: "plan",
        text: planText,
        approval_status: "success",
        time_created: timestampMs,
      };
      pendingPlan = planPart;
    }

    const displayText = cleanInternalText(fullText.replace(PROPOSED_PLAN_PATTERN, ""));
    if (!displayText) return pendingPlan;

    const textPart: MessagePart = { type: "text", text: displayText, time_created: timestampMs };
    transcript.appendAssistantPart(textPart, {
      id: "",
      timestampMs,
      agent: "codex",
      model: activeModel,
    });
    return pendingPlan;
  }

  // ---- User message ----

  private convertUserMessage(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    pendingPlan: MessagePart | null,
  ): MessagePart | null {
    const content = payload["content"];
    const text = Array.isArray(content)
      ? content
          .map((c) => {
            if (Array.isArray(c)) return "";
            const record = asRecord(c);
            return record ? String(record["text"] ?? "") : String(c ?? "");
          })
          .join(" ")
      : String(content ?? "");

    const visibleText = cleanInternalText(text);
    if (!visibleText) return pendingPlan;

    if (isDeveloperLikeUserMessage(visibleText)) return pendingPlan;

    if (visibleText.trimStart().startsWith(PLAN_APPROVAL_PREFIX)) {
      if (pendingPlan) transcript.appendToCurrentAssistant(pendingPlan);
      transcript.appendMessage({
        id: "",
        role: "user",
        timestampMs,
        parts: [{ type: "text", text: visibleText, time_created: timestampMs }],
      });
      return null;
    }

    const subagentMatch = visibleText.match(SUBAGENT_NOTIFICATION_PATTERN);
    if (subagentMatch) {
      // Malformed or non-object notification payloads fall through and are
      // treated as normal user messages below.
      let notifPayload: Record<string, unknown> | undefined;
      try {
        notifPayload = asRecord(JSON.parse(subagentMatch[1]!));
      } catch {
        notifPayload = undefined;
      }

      if (notifPayload) {
        const agentId = String(notifPayload["agent_id"] ?? "");
        const nickname = String(notifPayload["nickname"] ?? "");
        const completedText = String(notifPayload["completed"] ?? "");

        const textPart: MessagePart = {
          type: "text",
          text: completedText || `Subagent ${nickname} completed`,
          time_created: timestampMs,
        };

        transcript.appendMessage({
          id: "",
          role: "assistant",
          timestampMs,
          parts: [textPart],
          agent: "codex",
          subagentId: agentId || undefined,
          nickname: nickname || undefined,
        });
        transcript.beginTurn();
        return pendingPlan;
      }
    }

    transcript.appendMessage({
      id: "",
      role: "user",
      timestampMs,
      parts: [{ type: "text", text: visibleText, time_created: timestampMs }],
    });
    return pendingPlan;
  }

  // ---- Reasoning ----

  private convertReasoning(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const summary = payload["summary"];
    if (!Array.isArray(summary)) return;

    const texts: string[] = [];
    for (const item of summary) {
      const ci = asRecord(item);
      if (!ci) continue;
      if (String(ci["type"] ?? "") === "summary_text") {
        const text = String(ci["text"] ?? "");
        if (text.trim()) texts.push(text);
      }
    }

    if (texts.length === 0) return;

    const reasoningText = texts.join("\n");
    const part: MessagePart = { type: "reasoning", text: reasoningText, time_created: timestampMs };
    transcript.appendAssistantPart(
      part,
      {
        id: "",
        timestampMs,
        agent: "codex",
        model: activeModel,
      },
      { resetLatestText: true },
    );
  }

  // ---- Function call ----

  private convertFunctionCall(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    const name = String(payload["name"] ?? "").trim();
    if (!name) return;

    const toolIdentity = resolveToolIdentity(name, payload["namespace"]);
    const arguments_ = normalizeToolArguments(payload["arguments"]);

    const toolPart: MessagePart = {
      type: "tool",
      tool: toolIdentity.tool,
      callID: callId,
      title: `Tool: ${toolIdentity.tool}`,
      state: {
        status: "running",
        input: arguments_,
        output: null,
        metadata: toolIdentity.metadata,
      },
      time_created: timestampMs,
    };

    transcript.appendToolCall(
      toolPart,
      { id: "", timestampMs, agent: "codex", model: activeModel },
      { markModeAsTool: true },
    );
  }

  // ---- Function call output ----

  private convertToolCallOutput(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    if (!callId) return;

    const outputText = cleanInternalText(
      stripExecOutputEnvelope(flattenOutputText(payload["output"])),
    );
    const outputParts: MessagePart[] = outputText
      ? [{ type: "text", text: outputText, time_created: timestampMs }]
      : [];

    if (outputParts.length > 0) {
      transcript.resolveToolCall(callId, { output: outputParts, status: "completed" });
    }
  }

  // ---- Custom tool call ----

  private convertCustomToolCall(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    const name = String(payload["name"] ?? "").trim();
    if (!name) return;

    // Code-mode exec: the JS program wraps native tool calls. Decode each
    // inner call back to its classic tool part so existing displays apply.
    // Programs with no recognizable call fall through to the raw exec part.
    if (name === "exec") {
      const decoded = decodeExecCalls(payload["input"]);
      if (decoded.length > 0) {
        this.appendDecodedExecCalls(decoded, callId, transcript, timestampMs, activeModel);
        return;
      }
    }

    const toolIdentity = resolveToolIdentity(name, payload["namespace"]);
    const rawInput = payload["input"];
    const normalizedInput = normalizeCustomToolArguments(name, rawInput);

    const toolPart: MessagePart = {
      type: "tool",
      tool: toolIdentity.tool,
      callID: callId,
      title: `Tool: ${toolIdentity.tool}`,
      state: {
        status: "running",
        input: normalizedInput,
        output: null,
        metadata: toolIdentity.metadata,
      },
      time_created: timestampMs,
    };

    transcript.appendToolCall(
      toolPart,
      { id: "", timestampMs, agent: "codex", model: activeModel },
      { markModeAsTool: true },
    );
  }

  // ---- Decoded code-mode exec calls ----

  private appendDecodedExecCalls(
    calls: ExecInnerCall[],
    callId: string,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    // Only one output record follows, keyed by the exec call id; route it to
    // the output-bearing part and give the rest unique ids so they still
    // register and render, just without a resolved output.
    const outputIndex = pickExecOutputTarget(calls);
    calls.forEach((call, index) => {
      const partCallId = index === outputIndex ? callId : `${callId}#${index}`;
      this.appendDecodedExecCall(call, partCallId, transcript, timestampMs, activeModel);
    });
  }

  private appendDecodedExecCall(
    call: ExecInnerCall,
    callId: string,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const { name, namespace } = splitExecToolName(call.name);
    const toolIdentity = resolveToolIdentity(name, namespace);
    const arguments_ =
      name === "apply_patch" ? parseApplyPatchInput(getExecPatchText(call.args)) : call.args;

    const toolPart: MessagePart = {
      type: "tool",
      tool: toolIdentity.tool,
      callID: callId,
      title: `Tool: ${toolIdentity.tool}`,
      state: {
        status: "running",
        input: arguments_,
        output: null,
        metadata: toolIdentity.metadata,
      },
      time_created: timestampMs,
    };

    transcript.appendToolCall(
      toolPart,
      { id: "", timestampMs, agent: "codex", model: activeModel },
      { markModeAsTool: true },
    );
  }
}
