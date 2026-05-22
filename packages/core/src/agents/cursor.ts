import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  BaseAgent,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
} from "./base.js";
import type { AgentScanOptions, SessionCacheMeta, ChangeCheckResult } from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { getCursorDataPath } from "../discovery/paths.js";
import { openDbReadOnly, isSqliteAvailable, type SQLiteDatabase } from "../utils/sqlite.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import {
  cleanInternalText,
  cleanParsedMessages,
  firstUserMessageTitle,
} from "../utils/session-normalization.js";
import { perf } from "../utils/perf.js";
import { estimateTokenCost } from "../utils/cost.js";

// ---------------------------------------------------------------------------
// Cursor data model interfaces
// ---------------------------------------------------------------------------

interface ComposerData {
  id?: string;
  composerId?: string;
  text?: string;
  name?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  lastSendTime?: number;
  lastUpdatedAt?: number;
  model?: string;
  modelConfig?: { modelName?: string };
  inputTokenCount?: number;
  outputTokenCount?: number;
  subagentInfos?: SubagentInfo[];
  chatMessages?: ChatMessage[];
  usageData?: {
    contextTokensUsed?: number;
    contextTokenLimit?: number;
    contextUsagePercent?: number;
  };
}

interface BubbleData {
  id?: string;
  composerId?: string;
  chatMessages?: ChatMessage[];
  type?: number; // 1 = user, 2 = assistant
  text?: string;
  requestId?: string;
  createdAt?: number;
  timestamp?: number;
  timingInfo?: {
    clientRpcSendTime?: number;
    clientSettleTime?: number;
    clientEndTime?: number;
  };
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  modelInfo?: {
    modelName?: string;
  };
  toolFormerData?: {
    name?: string;
    toolCallId?: string;
    status?: string;
    params?: unknown;
    result?: unknown;
    additionalData?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface SubagentInfo {
  id?: string;
  composerId?: string;
  title?: string;
  nickname?: string;
}

interface ChatMessage {
  role: string;
  text?: string;
  createdAt?: number;
  timestamp?: number;
  actions?: ActionEntry[];
  isCompletion?: boolean;
  [key: string]: unknown;
}

interface ActionEntry {
  type?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CURSOR_TOOL_TITLE_MAP: Record<string, string> = {
  read_file_v2: "read",
  edit_file_v2: "edit",
  run_terminal_command_v2: "bash",
  ripgrep_raw_search: "grep",
  glob_file_search: "glob",
};

function mapToolTitle(toolName: string): string {
  return CURSOR_TOOL_TITLE_MAP[toolName] ?? toolName;
}

/** Normalize tool output into MessagePart[] */
function normalizeToolOutputParts(output: unknown, timestampMs: number): MessagePart[] {
  if (output == null) return [];

  if (typeof output === "string") {
    const text = cleanInternalText(output);
    return text ? [{ type: "text" as const, text, time_created: timestampMs }] : [];
  }

  if (Array.isArray(output)) {
    const parts: MessagePart[] = [];
    for (const item of output) {
      if (typeof item === "object" && item !== null) {
        const text = String(
          (item as Record<string, unknown>).text ?? (item as Record<string, unknown>).content ?? "",
        );
        const cleaned = cleanInternalText(text);
        if (cleaned) parts.push({ type: "text", text: cleaned, time_created: timestampMs });
      } else if (typeof item === "string") {
        const text = cleanInternalText(item);
        if (text) parts.push({ type: "text", text, time_created: timestampMs });
      }
    }
    return parts;
  }

  // For object output, stringify for readability
  const text = cleanInternalText(String(output));
  return text ? [{ type: "text", text, time_created: timestampMs }] : [];
}

/** Extract a timestamp (in ms) from a chat message */
function extractTimestamp(msg: ChatMessage): number {
  if (msg.createdAt && typeof msg.createdAt === "number" && msg.createdAt > 0) {
    return msg.createdAt;
  }
  if (msg.timestamp && typeof msg.timestamp === "number" && msg.timestamp > 0) {
    return msg.timestamp;
  }
  return 0;
}

function isInternalBubble(bubble: BubbleData): boolean {
  return ["eventType", "kind", "subtype", "name"].some((key) => isInternalEventType(bubble[key]));
}

/** Build a normalized tool state object from an action entry */
function buildToolState(action: ActionEntry): MessagePart["state"] {
  const state: MessagePart["state"] = {};

  // Copy input
  if (action.input) {
    state.input = action.input;
  }

  // Normalize output into parts
  if (action.output != null) {
    const ts = 0; // we don't have a finer-grained timestamp for the output
    const outputParts = normalizeToolOutputParts(action.output, ts);
    state.output = outputParts.length > 0 ? outputParts : action.output;
  }

  // Merge any explicit state fields
  if (action.state) {
    Object.assign(state, action.state);
  }

  // Derive status from output shape if not set
  if (!state.status) {
    if (typeof action.output === "object" && action.output !== null) {
      const out = action.output as Record<string, unknown>;
      if (out.success === true) state.status = "completed";
      else if (out.success === false) state.status = "error";
      else state.status = "completed";
    } else if (action.output != null) {
      state.status = "completed";
    }
  }

  return state;
}

/** Build a MessagePart for a tool action */
function buildToolPart(action: ActionEntry, timestampMs: number): MessagePart {
  const toolName = action.tool ?? "unknown";
  return {
    type: "tool",
    tool: mapToolTitle(toolName),
    callID: action.type ? `${action.type}:${String(action.input?.id ?? "")}` : "",
    title: `Tool: ${mapToolTitle(toolName)}`,
    state: buildToolState(action),
    time_created: timestampMs,
  };
}

/** Build a MessagePart for terminal command actions */
function buildTerminalToolPart(action: ActionEntry, timestampMs: number): MessagePart {
  const command = String(action.input?.command ?? "");
  const description = cleanInternalText(String(action.input?.commandDescription ?? ""));

  return {
    type: "tool",
    tool: "bash",
    callID: "",
    title: description || `bash: ${command.slice(0, 60)}`,
    state: {
      input: { command },
      output:
        typeof action.output === "string"
          ? [{ type: "text" as const, text: action.output, time_created: timestampMs }]
          : normalizeToolOutputParts(action.output, timestampMs),
    },
    time_created: timestampMs,
  };
}

/** Convert an ActionEntry into a MessagePart */
function convertActionToPart(action: ActionEntry, timestampMs: number): MessagePart | null {
  const toolName = action.tool ?? "";

  // Terminal commands get special handling
  if (toolName === "run_terminal_command_v2") {
    return buildTerminalToolPart(action, timestampMs);
  }

  // Generic tool call
  if (toolName && action.type === "tool") {
    return buildToolPart(action, timestampMs);
  }

  return null;
}

// ---------------------------------------------------------------------------
// CursorAgent
// ---------------------------------------------------------------------------

export class CursorAgent extends BaseAgent {
  readonly name = "cursor";
  readonly displayName = "Cursor";

  private dbPath: string | null = null;

  // Cache composer data from scan so getSessionData can reuse it
  private composerCache = new Map<string, ComposerData>();

  // Session metadata for caching
  private sessionMetaMap = new Map<string, { id: string; sourcePath: string }>();

  private findDbPath(): string | null {
    if (!isSqliteAvailable()) return null;
    const dataPath = getCursorDataPath();
    if (!dataPath) return null;
    return join(dataPath, "globalStorage", "state.vscdb");
  }

  /**
   * Build a map of composerId → workspace folder path by reading
   * workspaceStorage/{id}/workspace.json and the corresponding state.vscdb.
   */
  private buildWorkspacePathMap(): Map<string, string> {
    const map = new Map<string, string>();
    const dataPath = getCursorDataPath();
    if (!dataPath) return map;

    const wsStoragePath = join(dataPath, "workspaceStorage");
    if (!existsSync(wsStoragePath)) return map;

    let entryNames: string[];
    try {
      entryNames = readdirSync(wsStoragePath) as string[];
    } catch {
      return map;
    }

    for (const name of entryNames) {
      const wsDir = join(wsStoragePath, name);
      try {
        if (!statSync(wsDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const wsJsonPath = join(wsDir, "workspace.json");
      if (!existsSync(wsJsonPath)) continue;

      // Parse workspace.json to get the project folder path
      let workspacePath: string;
      try {
        const data = JSON.parse(readFileSync(wsJsonPath, "utf-8")) as {
          folder?: string;
          workspace?: string;
        };
        const uri = data.folder ?? data.workspace ?? "";
        if (!uri) continue;
        workspacePath = normalize(decodeURIComponent(uri.replace(/^file:\/\//, "")));
      } catch {
        continue;
      }

      // Read composer IDs from this workspace's state.vscdb (ItemTable)
      const wsDbPath = join(wsDir, "state.vscdb");
      if (!existsSync(wsDbPath)) continue;

      const wsDb = openDbReadOnly(wsDbPath);
      if (!wsDb) continue;

      try {
        const row = wsDb
          .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get() as { value: string } | undefined;
        if (!row?.value) continue;

        const parsed = JSON.parse(row.value) as unknown;
        let composers: Array<{ composerId?: string; id?: string }>;

        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "allComposers" in (parsed as Record<string, unknown>) &&
          Array.isArray((parsed as Record<string, unknown>)["allComposers"])
        ) {
          composers = (parsed as { allComposers: Array<{ composerId?: string; id?: string }> })
            .allComposers;
        } else if (Array.isArray(parsed)) {
          composers = parsed as Array<{ composerId?: string; id?: string }>;
        } else {
          continue;
        }

        for (const c of composers) {
          const id = c.composerId ?? c.id;
          if (id) map.set(id, workspacePath);
        }
      } catch {
        // skip unreadable workspace db
      } finally {
        wsDb.close();
      }
    }

    return map;
  }

  isAvailable(): boolean {
    this.dbPath = this.findDbPath();
    return this.dbPath !== null && existsSync(this.dbPath);
  }

  scan(options?: AgentScanOptions): SessionHead[] {
    if (!this.dbPath) return [];

    const scanMarker = perf.start("cursor:scan");

    const dbMarker = perf.start("openDatabase");
    const db = this.openDatabase();
    perf.end(dbMarker);

    if (!db) return [];

    // Build composerId → workspace path map from workspaceStorage
    const wsMarker = perf.start("buildWorkspacePathMap");
    const workspacePathMap = this.buildWorkspacePathMap();
    perf.end(wsMarker);

    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key: string; value: string }>;

      const heads: SessionHead[] = [];
      options?.onProgress?.({ total: rows.length, processed: 0, sessions: 0 });
      let processed = 0;

      for (const row of rows) {
        try {
          const composer = JSON.parse(row.value) as ComposerData;
          if (!composer.id && !composer.composerId) continue;

          const composerId = composer.id || composer.composerId || "";
          const createdAt = composer.createdAt ?? 0;
          const updatedAt =
            composer.updatedAt ?? composer.lastUpdatedAt ?? composer.lastSendTime ?? createdAt;
          if (!matchesScanWindow(updatedAt, options)) continue;

          const fastTitle = this.extractTitle(composer);
          const hasFastMessages = Array.isArray(composer.chatMessages);
          const fastMessageCount = composer.chatMessages?.length ?? 0;
          const hasSubagents =
            Array.isArray(composer.subagentInfos) && composer.subagentInfos.length > 0;
          if (options?.fast) {
            const directory = workspacePathMap.get(composerId) ?? "";
            const totalCost =
              estimateTokenCost(composer.modelConfig?.modelName ?? composer.model, {
                input: composer.inputTokenCount ?? 0,
                output: composer.outputTokenCount ?? 0,
              }) ?? 0;
            const head = getParsedSession(
              hasFastMessages && fastMessageCount === 0 && !hasSubagents
                ? filteredSession<SessionHead>("no visible messages")
                : parsedSession<SessionHead>({
                    id: composerId,
                    slug: `cursor/${composerId}`,
                    title: fastTitle,
                    directory,
                    time_created: createdAt,
                    time_updated: updatedAt || undefined,
                    stats: {
                      message_count: fastMessageCount,
                      total_input_tokens: composer.inputTokenCount ?? 0,
                      total_output_tokens: composer.outputTokenCount ?? 0,
                      total_cost: totalCost,
                      cost_source: totalCost > 0 ? "estimated" : undefined,
                    },
                  }),
            );
            if (!head) continue;
            heads.push(head);
            this.composerCache.set(composerId, composer);
            this.sessionMetaMap.set(composerId, {
              id: composerId,
              sourcePath: this.dbPath || "",
            });
            continue;
          }

          // Try to extract requestId from bubbles (like agent-dump does)
          const requestId = this.extractRequestIdFromBubbles(db, composerId);
          const sessionId = requestId || composerId;

          // Load actual messages to filter out empty composers
          const parsedMessages = cleanParsedMessages(
            this.loadMessagesFromBubbles(
              db,
              composerId,
              sessionId,
              composer.modelConfig?.modelName ?? composer.model ?? null,
            ),
          );
          const messages = getParsedSession(
            parsedMessages.length === 0 && !hasSubagents
              ? filteredSession<Message[]>("no visible messages")
              : parsedSession(parsedMessages),
          );
          if (!messages) continue;
          const messageCount = messages.length;
          const title = this.extractTitle(composer, messages);

          const directory = workspacePathMap.get(composerId) ?? "";

          const modelUsageMap: Record<string, number> = {};
          let totalCost = 0;
          for (const msg of messages) {
            totalCost += msg.cost ?? 0;
            if (msg.model) {
              const msgTokens = (msg.tokens?.input ?? 0) + (msg.tokens?.output ?? 0);
              if (msgTokens > 0) {
                modelUsageMap[msg.model] = (modelUsageMap[msg.model] ?? 0) + msgTokens;
              }
            }
          }
          const hasModelUsage = Object.keys(modelUsageMap).length > 0;

          heads.push({
            id: sessionId,
            slug: `cursor/${sessionId}`,
            title,
            directory,
            time_created: createdAt,
            time_updated: updatedAt || undefined,
            stats: {
              message_count: messageCount,
              total_input_tokens: composer.inputTokenCount ?? 0,
              total_output_tokens: composer.outputTokenCount ?? 0,
              total_cost: totalCost,
              cost_source: totalCost > 0 ? "estimated" : undefined,
            },
            model_usage: hasModelUsage ? modelUsageMap : undefined,
          });

          // Cache with sessionId (requestId) as key
          this.composerCache.set(sessionId, composer);
          // Also cache composerId -> sessionId mapping and directory
          this.composerCache.set(`__mapping__${composerId}`, {
            sessionId,
          } as unknown as ComposerData);
          if (directory) {
            this.composerCache.set(`__dir__${composerId}`, {
              directory,
            } as unknown as ComposerData);
          }

          // Store session metadata for caching
          this.sessionMetaMap.set(sessionId, {
            id: sessionId,
            sourcePath: this.dbPath || "",
          });
        } catch {
          // skip malformed entries
        } finally {
          processed += 1;
          options?.onProgress?.({ total: rows.length, processed, sessions: heads.length });
        }
      }

      perf.end(scanMarker);
      return heads;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.sessionMetaMap as Map<string, SessionCacheMeta>;
  }

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    this.sessionMetaMap = meta as Map<string, { id: string; sourcePath: string }>;
  }

  /**
   * 检测数据库变更
   * 对于 SQLite，检测数据库文件修改时间
   */
  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    if (!this.dbPath || !existsSync(this.dbPath)) {
      return { hasChanges: false, timestamp: Date.now() };
    }

    try {
      // 检测数据库文件修改时间
      const stat = statSync(this.dbPath);
      const hasChanges = stat.mtimeMs > sinceTimestamp;

      // 如果数据库有变更，标记所有缓存会话需要刷新
      // 因为 SQLite 内部变更检测较复杂，简单起见全部刷新
      const changedIds = hasChanges ? cachedSessions.map((s) => s.id) : [];

      return {
        hasChanges,
        changedIds,
        timestamp: Date.now(),
      };
    } catch {
      return { hasChanges: false, timestamp: Date.now() };
    }
  }

  /**
   * 增量扫描 - 重新查询数据库
   */
  incrementalScan(_cachedSessions: SessionHead[], _changedIds: string[]): SessionHead[] {
    // 对于 Cursor，直接重新执行完整扫描
    // 因为 scan() 方法已经做了很好的优化
    return this.scan();
  }

  getSessionData(sessionId: string): SessionData {
    // Ensure dbPath is set
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    if (!this.dbPath) {
      throw new Error("Cursor database is missing");
    }

    const db = this.openDatabase();
    if (!db) {
      throw new Error("Cursor database is missing");
    }

    try {
      // Try cached composer data first
      let composer = this.composerCache.get(sessionId);
      let resolvedSessionId = sessionId;

      if (!composer) {
        // Try loading directly by sessionId (might be composerId)
        composer = this.loadComposer(db, sessionId) ?? undefined;
      }

      if (!composer) {
        // sessionId might be a requestId - try to find the composer
        const composerId = this.findComposerIdByRequestId(db, sessionId);
        if (composerId) {
          composer = this.loadComposer(db, composerId) ?? undefined;
          resolvedSessionId = sessionId; // Keep the requestId as sessionId
        }
      }

      if (!composer) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const composerId = composer.id || composer.composerId || "";
      const createdAt = composer.createdAt ?? 0;
      const updatedAt = composer.updatedAt ?? createdAt;

      // Load messages from bubbles (like agent-dump does)
      const messages = this.loadMessagesFromBubbles(
        db,
        composerId,
        resolvedSessionId,
        composer.modelConfig?.modelName ?? composer.model ?? null,
      );

      // Append subagent messages
      this.appendSubagentMessages(db, composer, messages);
      const cleanedMessages = cleanParsedMessages(messages);
      const title = this.extractTitle(composer, cleanedMessages);

      // Aggregate stats
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;

      for (const msg of cleanedMessages) {
        totalInputTokens += msg.tokens?.input ?? 0;
        totalOutputTokens += msg.tokens?.output ?? 0;
        totalCost += msg.cost ?? 0;
      }

      // Use session-level token counts if per-message counts are zero
      if (totalInputTokens === 0) totalInputTokens = composer.inputTokenCount ?? 0;
      if (totalOutputTokens === 0) totalOutputTokens = composer.outputTokenCount ?? 0;
      if (totalCost === 0) {
        totalCost =
          estimateTokenCost(composer.modelConfig?.modelName ?? composer.model, {
            input: totalInputTokens,
            output: totalOutputTokens,
          }) ?? 0;
      }

      // Retrieve directory from cache (populated during scan) or build map on demand
      const cachedDir = this.composerCache.get(`__dir__${composerId}`);
      const directory =
        (cachedDir as unknown as { directory?: string })?.directory ??
        this.buildWorkspacePathMap().get(composerId) ??
        "";

      return {
        id: resolvedSessionId,
        title,
        slug: `cursor/${resolvedSessionId}`,
        directory,
        time_created: createdAt,
        time_updated: updatedAt || undefined,
        stats: {
          message_count: cleanedMessages.length,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_cost: totalCost,
          cost_source: totalCost > 0 ? "estimated" : undefined,
        },
        messages: cleanedMessages,
      };
    } finally {
      db.close();
    }
  }

  // --- Private helpers ---

  private openDatabase(): SQLiteDatabase | null {
    if (!this.dbPath) return null;
    return openDbReadOnly(this.dbPath);
  }

  /** Extract requestId from bubbles for a composer (like agent-dump) */
  private extractRequestIdFromBubbles(db: SQLiteDatabase, composerId: string): string | null {
    try {
      const rows = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key")
        .all(`bubbleId:${composerId}:%`) as Array<{ value: string }>;

      for (const row of rows) {
        try {
          const bubble = JSON.parse(row.value) as BubbleData;
          if (bubble.requestId && typeof bubble.requestId === "string" && bubble.requestId.trim()) {
            return bubble.requestId.trim();
          }
        } catch {
          // skip malformed bubbles
        }
      }
    } catch {
      // ignore errors
    }
    return null;
  }

  /** Find composerId by requestId (reverse lookup) */
  private findComposerIdByRequestId(db: SQLiteDatabase, requestId: string): string | null {
    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE ?")
        .all(`%"requestId":"${requestId}"%`) as Array<{ key: string; value: string }>;

      for (const row of rows) {
        try {
          const bubble = JSON.parse(row.value) as BubbleData;
          if (bubble.requestId === requestId) {
            // Extract composerId from key (bubbleId:{composerId}:{bubbleId})
            const keyParts = row.key.split(":");
            if (keyParts.length >= 2 && keyParts[1]) {
              return keyParts[1];
            }
          }
        } catch {
          // skip malformed bubbles
        }
      }
    } catch {
      // ignore errors
    }
    return null;
  }

  /** Extract title from composer (like agent-dump) */
  private extractTitle(composer: ComposerData, messages: Message[] = []): string {
    const explicit = composer.name || composer.title;
    const messageTitle = firstUserMessageTitle(messages) ?? composer.text;
    return resolveSessionTitle(explicit, messageTitle, null);
  }

  /** Count messages from bubbles */
  private countMessagesFromBubbles(db: SQLiteDatabase, composerId: string): number {
    try {
      const rows = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ?")
        .all(`bubbleId:${composerId}:%`) as Array<{ value: string }>;

      let count = 0;
      for (const row of rows) {
        try {
          const bubble = JSON.parse(row.value) as BubbleData;
          // type 1 = user, type 2 = assistant
          if (bubble.type === 1 || bubble.type === 2) {
            count++;
          }
        } catch {
          // skip malformed bubbles
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  /** Load messages from bubbles (like agent-dump) */
  private loadMessagesFromBubbles(
    db: SQLiteDatabase,
    composerId: string,
    _sessionId: string,
    initialModelName: string | null,
  ): Message[] {
    const messages: Message[] = [];

    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC")
        .all(`bubbleId:${composerId}:%`) as Array<{ key: string; value: string }>;

      let activeModelName: string | null = initialModelName;
      let messageIndex = 0;

      for (const row of rows) {
        try {
          const bubble = JSON.parse(row.value) as BubbleData;
          if (isInternalBubble(bubble)) continue;
          const bubbleId = row.key.split(":").pop() || String(messageIndex);

          // Determine role: type 2 = assistant, otherwise user
          const role = bubble.type === 2 ? "assistant" : "user";

          // Extract timestamp
          let timestampMs = 0;
          if (bubble.timingInfo?.clientRpcSendTime) {
            timestampMs = Math.floor(bubble.timingInfo.clientRpcSendTime);
          } else if (bubble.createdAt) {
            timestampMs = bubble.createdAt;
          } else if (bubble.timestamp) {
            timestampMs = bubble.timestamp;
          }

          // Track model from user turn
          if (bubble.modelInfo?.modelName) {
            activeModelName = bubble.modelInfo.modelName;
          }

          // Extract tokens
          const inputTokens = bubble.tokenCount?.inputTokens ?? 0;
          const outputTokens = bubble.tokenCount?.outputTokens ?? 0;

          // Build message parts
          const parts: MessagePart[] = [];

          // Text content
          const text = cleanInternalText(bubble.text ?? "");
          if (text) {
            parts.push({ type: "text", text, time_created: timestampMs });
          }

          // Tool calls from toolFormerData
          if (bubble.toolFormerData) {
            const toolPart = this.convertToolFormerData(bubble.toolFormerData, timestampMs);
            if (toolPart) {
              parts.push(toolPart);
            }
          }

          // Skip empty messages
          if (parts.length === 0) continue;

          const modelName = bubble.modelInfo?.modelName ?? activeModelName;
          const tokens = { input: inputTokens, output: outputTokens };
          const cost = estimateTokenCost(modelName, tokens);

          messages.push({
            id: `cursor-${composerId}-${bubbleId}`,
            role: role as Message["role"],
            agent: "cursor",
            time_created: timestampMs,
            time_completed: null,
            mode: role === "assistant" && parts.some((p) => p.type === "tool") ? "tool" : null,
            model: modelName,
            provider: null,
            tokens,
            cost: cost ?? 0,
            cost_source: cost !== null ? "estimated" : undefined,
            parts,
          });

          messageIndex++;
        } catch {
          // skip malformed bubbles
        }
      }
    } catch {
      // ignore errors
    }

    return messages;
  }

  /** Convert toolFormerData to MessagePart */
  private convertToolFormerData(
    toolData: BubbleData["toolFormerData"],
    timestampMs: number,
  ): MessagePart | null {
    if (!toolData || !toolData.name) return null;

    const toolName = toolData.name;
    const normalizedName = toolName === "create_plan" ? "plan" : mapToolTitle(toolName);

    // Build state
    const state: MessagePart["state"] = {
      status: toolData.status === "completed" ? "completed" : "running",
    };

    // Parse input params
    if (toolData.params) {
      if (typeof toolData.params === "string") {
        try {
          state.input = JSON.parse(toolData.params);
        } catch {
          state.input = { _raw: toolData.params };
        }
      } else {
        state.input = toolData.params;
      }
    }

    // Parse result/output
    if (toolData.result !== undefined) {
      if (typeof toolData.result === "string") {
        try {
          const parsed = JSON.parse(toolData.result);
          state.output = parsed;
          if (parsed.error || parsed.message || parsed.stderr) {
            state.error = parsed.error || parsed.message || parsed.stderr;
            state.status = "error";
          }
        } catch {
          state.output = toolData.result;
        }
      } else {
        state.output = toolData.result;
      }
    }

    // Handle plan tool specially
    if (toolName === "create_plan") {
      const planText =
        typeof state.input === "object" && state.input !== null
          ? (state.input as Record<string, unknown>).plan
          : undefined;
      return {
        type: "plan",
        title: "Plan",
        input: planText,
        approval_status: state.status === "completed" ? "success" : "fail",
        state,
        time_created: timestampMs,
      };
    }

    return {
      type: "tool",
      tool: normalizedName,
      callID: toolData.toolCallId || "",
      title: `Tool: ${normalizedName}`,
      state,
      time_created: timestampMs,
    };
  }

  private loadComposer(db: SQLiteDatabase, sessionId: string): ComposerData | null {
    const row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${sessionId}`) as { value: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.value) as ComposerData;
    } catch {
      return null;
    }
  }

  private loadBubble(db: SQLiteDatabase, sessionId: string): BubbleData | null {
    const row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubble:${sessionId}`) as { value: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.value) as BubbleData;
    } catch {
      return null;
    }
  }

  private appendSubagentMessages(
    db: SQLiteDatabase,
    composer: ComposerData,
    messages: Message[],
  ): void {
    const subagentInfos = composer.subagentInfos;
    if (!Array.isArray(subagentInfos) || subagentInfos.length === 0) return;

    for (const subInfo of subagentInfos) {
      if (!subInfo.id) continue;

      const bubble = this.loadBubble(db, subInfo.id);
      if (!bubble || !Array.isArray(bubble.chatMessages)) continue;

      for (const chatMsg of bubble.chatMessages) {
        const role = chatMsg.role?.trim().toLowerCase();
        if (role !== "user" && role !== "assistant") continue;

        const timestampMs = extractTimestamp(chatMsg);
        const parts: MessagePart[] = [];

        const text = cleanInternalText(chatMsg.text ?? "");
        if (text) {
          parts.push({ type: "text", text, time_created: timestampMs });
        }

        if (role === "assistant" && Array.isArray(chatMsg.actions)) {
          for (const action of chatMsg.actions) {
            if (isInternalEventType(action.type) || isInternalEventType(action.tool)) continue;
            const part = convertActionToPart(action as ActionEntry, timestampMs);
            if (part) parts.push(part);
          }
        }

        if (parts.length === 0) continue;

        messages.push({
          id: `cursor-sub-${subInfo.id}`,
          role: role as Message["role"],
          agent: "cursor",
          time_created: timestampMs,
          time_completed: null,
          mode: null,
          model: null,
          provider: null,
          tokens: undefined,
          cost: 0,
          subagent_id: subInfo.id,
          nickname: subInfo.nickname ?? subInfo.title,
          parts,
        });
      }
    }
  }
}
