import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { BaseAgent } from "./base.js";
import type { SessionCacheMeta, ChangeCheckResult } from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { getCursorDataPath } from "../discovery/paths.js";
import { openDbReadOnly, isSqliteAvailable, type SQLiteDatabase } from "../utils/sqlite.js";
import { perf } from "../utils/perf.js";

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
    return output.trim()
      ? [{ type: "text" as const, text: output, time_created: timestampMs }]
      : [];
  }

  if (Array.isArray(output)) {
    const parts: MessagePart[] = [];
    for (const item of output) {
      if (typeof item === "object" && item !== null) {
        const text = String(
          (item as Record<string, unknown>).text ?? (item as Record<string, unknown>).content ?? "",
        );
        if (text.trim()) parts.push({ type: "text", text, time_created: timestampMs });
      } else if (typeof item === "string" && item.trim()) {
        parts.push({ type: "text", text: item, time_created: timestampMs });
      }
    }
    return parts;
  }

  // For object output, stringify for readability
  const text = String(output);
  return text.trim() ? [{ type: "text", text, time_created: timestampMs }] : [];
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
  const description = String(action.input?.commandDescription ?? "");

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

  scan(): SessionHead[] {
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

      for (const row of rows) {
        try {
          const composer = JSON.parse(row.value) as ComposerData;
          if (!composer.id && !composer.composerId) continue;

          const composerId = composer.id || composer.composerId || "";

          // Try to extract requestId from bubbles (like agent-dump does)
          const requestId = this.extractRequestIdFromBubbles(db, composerId);
          const sessionId = requestId || composerId;

          const title = this.extractTitle(composer);
          const createdAt = composer.createdAt ?? 0;
          const updatedAt = composer.updatedAt ?? createdAt;

          // Load actual messages to filter out empty composers
          const messages = this.loadMessagesFromBubbles(
            db,
            composerId,
            sessionId,
            composer.modelConfig?.modelName ?? composer.model ?? null,
          );
          const hasSubagents =
            Array.isArray(composer.subagentInfos) && composer.subagentInfos.length > 0;
          if (messages.length === 0 && !hasSubagents) {
            continue; // Skip empty sessions
          }
          const messageCount = messages.length;

          const directory = workspacePathMap.get(composerId) ?? "";

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
              total_cost: 0,
            },
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
      const title = this.extractTitle(composer);
      const createdAt = composer.createdAt ?? 0;
      const updatedAt = composer.updatedAt ?? createdAt;

      // Load messages from bubbles (like agent-dump does)
      const messages = this.loadMessagesFromBubbles(
        db,
        composerId,
        resolvedSessionId,
        composer.modelConfig?.modelName ?? composer.model ?? null,
      );

      // Aggregate stats
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const msg of messages) {
        totalInputTokens += msg.tokens?.input ?? 0;
        totalOutputTokens += msg.tokens?.output ?? 0;
      }

      // Use session-level token counts if per-message counts are zero
      if (totalInputTokens === 0) totalInputTokens = composer.inputTokenCount ?? 0;
      if (totalOutputTokens === 0) totalOutputTokens = composer.outputTokenCount ?? 0;

      // Append subagent messages
      this.appendSubagentMessages(db, composer, messages);

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
          message_count: messages.length,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_cost: 0,
        },
        messages,
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
  private extractTitle(composer: ComposerData): string {
    if (composer.name && typeof composer.name === "string" && composer.name.trim()) {
      return composer.name.trim();
    }
    if (composer.title && typeof composer.title === "string" && composer.title.trim()) {
      return composer.title.trim();
    }
    if (composer.text && typeof composer.text === "string" && composer.text.trim()) {
      const firstLine = composer.text
        .split("\n")
        .find((l) => l.trim())
        ?.trim()
        .slice(0, 80);
      if (firstLine) return firstLine;
    }
    const composerId = composer.composerId || composer.id || "";
    return `Cursor Session ${composerId.slice(0, 8)}`;
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
          const text = bubble.text?.trim();
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

          messages.push({
            id: `cursor-${composerId}-${bubbleId}`,
            role: role as Message["role"],
            agent: "cursor",
            time_created: timestampMs,
            time_completed: null,
            mode: role === "assistant" && parts.some((p) => p.type === "tool") ? "tool" : null,
            model: bubble.modelInfo?.modelName ?? activeModelName,
            provider: null,
            tokens: { input: inputTokens, output: outputTokens },
            cost: 0,
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
      title: `Tool: ${toolName}`,
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

        const text = chatMsg.text ?? "";
        if (text.trim()) {
          parts.push({ type: "text", text, time_created: timestampMs });
        }

        if (role === "assistant" && Array.isArray(chatMsg.actions)) {
          for (const action of chatMsg.actions) {
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
