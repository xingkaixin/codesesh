import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, normalize } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import {
  DatabaseSessionSource,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
  SessionScanError,
} from "./base.js";
import type { AgentScanOptions, AgentSourceOptions } from "./base.js";
import type {
  SessionHead,
  SessionDetail,
  Message,
  MessagePart,
  ToolPartState,
} from "../types/index.js";
import { firstExisting, readEnvPath } from "../discovery/paths.js";
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
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { asArray, asRecord } from "../utils/narrow.js";

export function resolveCursorDataRoot(): string | null {
  const override = readEnvPath("CURSOR_DATA_PATH");
  if (override) return override;

  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    return firstExisting(join(homedir(), "Library", "Application Support", "Cursor", "User"));
  }
  if (currentPlatform === "linux") {
    const configRoot = readEnvPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
    return firstExisting(join(configRoot, "Cursor", "User"));
  }
  if (currentPlatform === "win32") {
    const appData = readEnvPath("APPDATA") ?? join(homedir(), "AppData", "Roaming");
    return firstExisting(join(appData, "Cursor", "User"));
  }
  return null;
}

import {
  composerUpdatedAt,
  composerIdFromBubbleKey,
  convertActionToPart,
  cursorToolStatus,
  extractTimestamp,
  groupBubbleRows,
  isInternalBubble,
  mapToolTitle,
  narrowString,
  parseBubbleRow,
  parseComposerRow,
  type BubbleData,
  type BubbleRow,
  type ComposerBubbles,
  type ComposerData,
  type PendingComposer,
} from "./cursor-records.js";

// ---------------------------------------------------------------------------
// CursorAgent
// ---------------------------------------------------------------------------

const AGENT_METADATA = getAgentCatalogEntry("cursor");

export class CursorAgent extends DatabaseSessionSource {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;

  private dbPath: string | null = null;

  private composerCache = new Map<string, ComposerData>();
  private directoryCache = new Map<string, string>();

  constructor(private readonly options: AgentSourceOptions = {}) {
    super();
  }

  private getDataRoot(): string | null {
    return this.options.sourceRoot ?? resolveCursorDataRoot();
  }

  protected getDatabasePath(): string | null {
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    return this.dbPath;
  }

  private findDbPath(): string | null {
    if (!isSqliteAvailable()) return null;
    const dataPath = this.getDataRoot();
    if (!dataPath) return null;
    return join(dataPath, "globalStorage", "state.vscdb");
  }

  getSessionWatchPlan() {
    const dataPath = this.getDataRoot();
    return {
      status: "supported" as const,
      targets: dataPath
        ? [
            {
              root: dataPath,
              path: join(dataPath, "globalStorage", "state.vscdb"),
            },
            {
              root: dataPath,
              path: join(dataPath, "workspaceStorage"),
              // Read-only SQLite opens can rewrite shared memory without changing sessions.
              ignoredFileNames: ["state.vscdb-shm"],
            },
          ]
        : [],
    };
  }

  /**
   * Build a map of composerId → workspace folder path by reading
   * workspaceStorage/{id}/workspace.json and the corresponding state.vscdb.
   */
  private buildWorkspacePathMap(): Map<string, string> {
    const map = new Map<string, string>();
    const dataPath = this.getDataRoot();
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
        if (!lstatSync(wsDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const wsJsonPath = join(wsDir, "workspace.json");
      if (!existsSync(wsJsonPath)) continue;

      // Parse workspace.json to get the project folder path
      let workspacePath: string;
      try {
        const data = asRecord(JSON.parse(readFileSync(wsJsonPath, "utf-8")));
        const uri =
          narrowString("workspaceJson.folder", data?.folder) ??
          narrowString("workspaceJson.workspace", data?.workspace) ??
          "";
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

        const parsed: unknown = JSON.parse(row.value);
        const composers = asArray(asRecord(parsed)?.allComposers) ?? asArray(parsed) ?? [];

        for (const item of composers) {
          const composer = asRecord(item);
          if (!composer) continue;
          const id =
            narrowString("workspaceComposer.composerId", composer.composerId) ??
            narrowString("workspaceComposer.id", composer.id);
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
    this.composerCache.clear();
    this.directoryCache.clear();
    if (!this.getDatabasePath()) return [];

    const scanMarker = perf.start("cursor:scan");

    const dbMarker = perf.start("openDatabase");
    const db = this.openDatabase();
    perf.end(dbMarker);

    if (!db) throw new SessionScanError(this.name, "opening the database");

    // Build composerId → workspace path map from workspaceStorage
    const wsMarker = perf.start("buildWorkspacePathMap");
    const workspacePathMap = this.buildWorkspacePathMap();
    perf.end(wsMarker);

    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key: string; value: string }>;

      // Heads are emitted by composer order regardless of which phase produced
      // them, so the scan output does not depend on how bubbles are read.
      const emitted = new Map<number, SessionHead>();
      const pending: PendingComposer[] = [];
      let order = 0;
      options?.onProgress?.({ total: rows.length, processed: 0, sessions: 0 });
      let processed = 0;

      for (const row of rows) {
        try {
          const composer = parseComposerRow(row.value);
          if (!composer || (!composer.id && !composer.composerId)) continue;

          const composerId = composer.id || composer.composerId || "";
          const createdAt = composer.createdAt ?? 0;
          const updatedAt = composerUpdatedAt(composer);
          if (!matchesScanWindow(updatedAt, options)) continue;

          const fastTitle = this.extractTitle(composer);
          const hasFastMessages = Array.isArray(composer.chatMessages);
          const fastMessageCount = composer.chatMessages?.length ?? 0;
          const hasSubagents =
            Array.isArray(composer.subagentInfos) && composer.subagentInfos.length > 0;
          if (options?.fast) {
            const directory = workspacePathMap.get(composerId) ?? "";
            const head = this.captureSessionPricingMisses(() => {
              const totalCost =
                estimateTokenCost(composer.modelConfig?.modelName ?? composer.model, {
                  input: composer.inputTokenCount ?? 0,
                  output: composer.outputTokenCount ?? 0,
                }) ?? 0;
              return getParsedSession(
                hasFastMessages && fastMessageCount === 0 && !hasSubagents
                  ? filteredSession<SessionHead>("no visible messages")
                  : parsedSession<SessionHead>({
                      ...this.sessionIdentity(composerId),
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
            });
            if (!head) continue;
            emitted.set(order, head);
            order += 1;
            this.composerCache.set(composerId, composer);
            if (directory) this.directoryCache.set(composerId, directory);
            continue;
          }

          pending.push({ composer, composerId, createdAt, updatedAt, hasSubagents, order });
          order += 1;
        } catch {
          // skip malformed entries
        } finally {
          processed += 1;
          options?.onProgress?.({ total: rows.length, processed, sessions: emitted.size });
        }
      }

      // Second phase: one ordered pass over every bubble row. Keys share the
      // composer prefix, so each group arrives contiguously and only one group
      // is held at a time — replacing two full scans per composer.
      const bubbleMarker = perf.start("cursor:bubbles");
      const wanted = new Map(pending.map((entry) => [entry.composerId, entry]));
      this.forEachComposerBubbles(db, wanted, (bubbles) => {
        const entry = wanted.get(bubbles.composerId);
        if (!entry) return;
        wanted.delete(bubbles.composerId);
        const head = this.captureSessionPricingMisses(() =>
          this.buildScanHead(entry, bubbles, workspacePathMap),
        );
        if (head) emitted.set(entry.order, head);
      });
      // Composers with no bubbles at all still go through the same builder.
      for (const entry of wanted.values()) {
        const head = this.captureSessionPricingMisses(() =>
          this.buildScanHead(
            entry,
            { composerId: entry.composerId, byKey: [], byRowId: [] },
            workspacePathMap,
          ),
        );
        if (head) emitted.set(entry.order, head);
      }
      perf.end(bubbleMarker);

      const heads = [...emitted.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, head]) => head);
      options?.onProgress?.({ total: rows.length, processed, sessions: heads.length });

      perf.end(scanMarker);
      return heads;
    } catch (error) {
      throw new SessionScanError(this.name, "reading composers", { cause: error });
    } finally {
      db.close();
    }
  }

  getSessionData(sessionId: string): SessionDetail {
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

      if (!composer) {
        // Try loading directly by sessionId (might be composerId)
        composer = this.loadComposer(db, sessionId) ?? undefined;
      }

      if (!composer) {
        // sessionId might be a requestId - try to find the composer
        const composerId = this.findComposerIdByRequestId(db, sessionId);
        if (composerId) {
          composer = this.loadComposer(db, composerId) ?? undefined;
        }
      }

      if (!composer) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const composerId = composer.id || composer.composerId || "";
      const createdAt = composer.createdAt ?? 0;
      const updatedAt = composerUpdatedAt(composer);

      // Load messages from bubbles (like agent-dump does)
      const messages = this.loadMessagesFromBubbles(
        db,
        composerId,
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

      const directory =
        this.directoryCache.get(composerId) ?? this.buildWorkspacePathMap().get(composerId) ?? "";

      return {
        ...this.sessionIdentity(composerId),
        title,
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

  /**
   * Streams every bubble row once, in key order, handing each composer's group
   * to the caller. A key-ordered scan keeps a composer's bubbles contiguous, so
   * only one group is materialized at a time.
   */
  private forEachComposerBubbles(
    db: SQLiteDatabase,
    wanted: Map<string, PendingComposer>,
    onGroup: (bubbles: ComposerBubbles) => void,
  ): void {
    if (wanted.size === 0) return;

    let currentId: string | null = null;
    let group: BubbleRow[] = [];
    const flush = () => {
      if (currentId != null && group.length > 0) onGroup(groupBubbleRows(group));
      group = [];
    };

    const rows = db
      .prepare(
        "SELECT rowid AS row_id, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY key",
      )
      .iterate() as Iterable<BubbleRow>;
    for (const row of rows) {
      const composerId = composerIdFromBubbleKey(row.key);
      if (composerId !== currentId) {
        flush();
        currentId = composerId;
      }
      if (wanted.has(composerId)) group.push(row);
    }
    flush();
  }

  /** Builds the head for one composer from bubbles that were parsed once. */
  private buildScanHead(
    entry: PendingComposer,
    bubbles: ComposerBubbles,
    workspacePathMap: Map<string, string>,
  ): SessionHead | null {
    const { composer, composerId, createdAt, updatedAt, hasSubagents } = entry;
    const legacySessionId = this.legacySessionIdFromBubbles(bubbles);

    const parsedMessages = cleanParsedMessages(
      this.messagesFromBubbles(bubbles, composer.modelConfig?.modelName ?? composer.model ?? null),
    );
    const messages = getParsedSession(
      parsedMessages.length === 0 && !hasSubagents
        ? filteredSession<Message[]>("no visible messages")
        : parsedSession(parsedMessages),
    );
    if (!messages) return null;
    if (legacySessionId) this.migrateLegacySessionMeta(legacySessionId, composerId);

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

    this.composerCache.set(composerId, composer);
    if (directory) this.directoryCache.set(composerId, directory);
    return {
      ...this.sessionIdentity(composerId),
      title,
      directory,
      time_created: createdAt,
      time_updated: updatedAt || undefined,
      stats: {
        message_count: messages.length,
        total_input_tokens: composer.inputTokenCount ?? 0,
        total_output_tokens: composer.outputTokenCount ?? 0,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? "estimated" : undefined,
      },
      model_usage: hasModelUsage ? modelUsageMap : undefined,
    };
  }

  private legacySessionIdFromBubbles(bubbles: ComposerBubbles): string | null {
    for (const entry of bubbles.byKey) {
      const requestId = entry.bubble.requestId?.trim();
      if (requestId) return requestId;
    }
    return null;
  }

  private migrateLegacySessionMeta(legacySessionId: string, sessionId: string): void {
    if (legacySessionId === sessionId) return;
    const legacyMeta = this.sessionMetaMap.get(legacySessionId);
    if (!legacyMeta) return;

    this.sessionMetaMap.delete(legacySessionId);
    if (!this.sessionMetaMap.has(sessionId)) {
      this.sessionMetaMap.set(sessionId, { ...legacyMeta, id: sessionId });
    }
    getCoreDiagnostics()?.info?.("cursor.session_id_migrated", {
      legacy_session_id: legacySessionId,
      session_id: sessionId,
    });
  }

  /** Find composerId by requestId (reverse lookup) */
  private findComposerIdByRequestId(db: SQLiteDatabase, requestId: string): string | null {
    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE ?")
        .all(`%"requestId":"${requestId}"%`) as Array<{ key: string; value: string }>;

      for (const row of rows) {
        try {
          const bubble = parseBubbleRow(row.value);
          if (bubble?.requestId === requestId) {
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

  /**
   * Load one composer's bubbles, for the detail path that only needs a
   * single session. A failing bubble query throws instead of returning [] —
   * a broken database must not read as an empty session.
   */
  private loadMessagesFromBubbles(
    db: SQLiteDatabase,
    composerId: string,
    initialModelName: string | null,
  ): Message[] {
    const rows = this.scanStep(
      "reading composer bubbles",
      this.getDatabasePath() ?? "",
      () =>
        db
          .prepare("SELECT rowid AS row_id, key, value FROM cursorDiskKV WHERE key LIKE ?")
          .all(`bubbleId:${composerId}:%`) as BubbleRow[],
    );
    return this.messagesFromBubbles(groupBubbleRows(rows), initialModelName);
  }

  /** Build messages from bubbles already parsed once, in insertion order. */
  private messagesFromBubbles(
    bubbles: ComposerBubbles,
    initialModelName: string | null,
  ): Message[] {
    const messages: Message[] = [];

    {
      let activeModelName: string | null = initialModelName;
      let messageIndex = 0;

      for (const entry of bubbles.byRowId) {
        {
          const bubble = entry.bubble;
          if (isInternalBubble(bubble)) continue;
          const bubbleId = entry.key.split(":").pop() || String(messageIndex);

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
            id: `cursor-${bubbles.composerId}-${bubbleId}`,
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
        }
      }
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
    const state: ToolPartState = {
      status: cursorToolStatus(toolData.status),
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
      let result = toolData.result;
      if (typeof toolData.result === "string") {
        try {
          result = JSON.parse(toolData.result);
        } catch {}
      }
      state.output = result;
      if (state.status === "error") {
        const resultRecord = asRecord(result);
        state.error =
          resultRecord?.error ?? resultRecord?.message ?? resultRecord?.stderr ?? result;
      }
    }

    // Handle plan tool specially
    if (toolName === "create_plan") {
      const planText = String(asRecord(state.input)?.plan ?? "").trim();
      if (planText) {
        return {
          type: "plan",
          text: planText,
          approval_status: state.status === "completed" ? "success" : "fail",
          time_created: timestampMs,
        };
      }
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

    return parseComposerRow(row.value);
  }

  private loadBubble(db: SQLiteDatabase, sessionId: string): BubbleData | null {
    const row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubble:${sessionId}`) as { value: string } | undefined;

    if (!row) return null;

    return parseBubbleRow(row.value);
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
            const part = convertActionToPart(action, timestampMs);
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
