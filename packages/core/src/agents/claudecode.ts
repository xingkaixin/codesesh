import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import {
  SingleFileSessionSource,
  filteredSession,
  getParsedSession,
  parsedSession,
  skippedSession,
} from "./base.js";
import type { ParseSessionResult } from "./base.js";
import type {
  SessionHead,
  SessionDetail,
  Message,
  MessagePart,
  ToolPart,
  ToolPartState,
} from "../types/index.js";
import { firstExisting, resolveHomePath } from "../discovery/paths.js";
import { readJsonlFile, readJsonlFileLines } from "../utils/jsonl.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { estimateTokenCost } from "../utils/cost.js";
import { parseAgentTimestampMs } from "../utils/timestamp.js";
import { asArray, asNumber, asRecord, asString, reportFieldMismatch } from "../utils/narrow.js";
import {
  matchesScanWindow,
  type AgentScanOptions,
  type FileSessionMeta,
  type SessionCacheMeta,
  type SessionSourceFile,
  type SessionSourceRef,
} from "./base.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";

// v5: heads cached before pricing misses were tracked may hold stale zero costs.
const HEAD_INDEX_VERSION = "claudecode-head-v5";

export function resolveClaudeCodeDataRoot(): string {
  return resolveHomePath("CLAUDE_CONFIG_DIR", ".claude");
}

interface ClaudeUsage {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

interface SessionMeta extends FileSessionMeta {
  indexPath: string | null;
  indexMtimeMs: number | null;
  headIndexVersion: string;
  model: string | null | undefined;
  parentSessionId: string | null;
  toolUseId: string | null;
}

interface ClaudeChildContext {
  sessionId: string;
  projectDir: string;
  parentSessionId: string | null;
  explicitTitle: string | null;
  metaMtimeMs: number | null;
  toolUseId: string | null;
}

interface ClaudeChildContextCacheEntry {
  metaMtimeMs: number | null;
  context: ClaudeChildContext;
}

function parseTimestampMs(data: Record<string, unknown>): number {
  const raw = data["timestamp"];
  const value = asString(raw);
  if (value === undefined) {
    if (raw !== undefined && raw !== null) reportFieldMismatch("claudecode", "timestamp");
    return 0;
  }
  return parseAgentTimestampMs(value, "claudecode");
}

/** Reads a numeric usage field; a present-but-wrong-typed field is a schema drift signal. */
function readUsageNumber(usage: Record<string, unknown>, field: string): number {
  const raw = usage[field];
  if (raw === undefined) return 0;
  const value = asNumber(raw);
  if (value === undefined) {
    reportFieldMismatch("claudecode", `message.usage.${field}`);
    return 0;
  }
  return value;
}

function extractClaudeUsage(
  data: Record<string, unknown>,
  msg: Record<string, unknown>,
): ClaudeUsage | null {
  const rawUsage = msg["usage"];
  if (rawUsage === undefined || rawUsage === null) return null;

  const usage = asRecord(rawUsage);
  if (!usage) {
    reportFieldMismatch("claudecode", "message.usage");
    return null;
  }

  const requestId = typeof data["requestId"] === "string" ? data["requestId"].trim() : "";
  const uuid = typeof data["uuid"] === "string" ? data["uuid"].trim() : "";
  const key = requestId || uuid;
  if (!key) return null;

  return {
    key,
    input: readUsageNumber(usage, "input_tokens"),
    output: readUsageNumber(usage, "output_tokens"),
    cacheRead: readUsageNumber(usage, "cache_read_input_tokens"),
    cacheCreate: readUsageNumber(usage, "cache_creation_input_tokens"),
  };
}

export class ClaudeCodeAgent extends SingleFileSessionSource<SessionMeta> {
  readonly name = "claudecode";
  readonly displayName = "Claude Code";

  private basePath: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionsIndexCache: Record<string, any> = {};
  private sessionsIndexMtime: Record<string, number | null> = {};
  private childContextsBySource = new Map<string, ClaudeChildContext>();
  private childContextCache = new Map<string, ClaudeChildContextCacheEntry>();
  private childSessionIdByToolUseId = new Map<string, string>();
  private childIndexReady = false;

  private findBasePath(): string | null {
    return firstExisting(join(resolveClaudeCodeDataRoot(), "projects"), "data/claudecode");
  }

  getSessionWatchPlan() {
    const dataRoot = resolveClaudeCodeDataRoot();
    return {
      status: "supported" as const,
      targets: [{ root: dataRoot, path: join(dataRoot, "projects") }, { path: "data/claudecode" }],
    };
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    for (const entry of this.readSessionSourceDirectory(this.basePath)) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.basePath, entry.name);
      if (
        this.readSessionSourceDirectory(directory).some(
          (child) => child.isFile() && child.name.endsWith(".jsonl"),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    const projectDirs = this.listProjectDirs();
    const indexMtimes = new Map<string, number | null>();
    for (const projectDir of projectDirs) {
      const indexPath = this.getSessionsIndexPath(projectDir);
      indexMtimes.set(projectDir, this.readFileMtimeMs(indexPath));
    }

    const projectDirSet = new Set(projectDirs);
    const allSources = this.walkFiles(projectDirs, (entry) => entry.name.endsWith(".jsonl"), {
      recursive: true,
    });
    this.indexChildContexts(allSources, projectDirs);
    const indexedSources = allSources.flatMap((source) => {
      const child = this.childContextsBySource.get(source.file);
      if (!child && !projectDirSet.has(dirname(source.file))) return [];
      return [
        {
          source,
          sessionId: child?.sessionId ?? basename(source.file, ".jsonl"),
          child,
        },
      ];
    });
    let selectedSources = indexedSources.filter(({ source }) =>
      matchesScanWindow(source.stat.mtimeMs, options),
    );

    if (options?.from != null || options?.to != null) {
      type IndexedSource = (typeof indexedSources)[number];
      const childrenByParent = new Map<string, IndexedSource[]>();
      for (const indexed of indexedSources) {
        const parentId = indexed.child?.parentSessionId;
        if (!parentId) continue;
        const children = childrenByParent.get(parentId);
        if (children) children.push(indexed);
        else childrenByParent.set(parentId, [indexed]);
      }

      const windowSelectedById = new Map(
        selectedSources.map((indexed) => [indexed.sessionId, indexed]),
      );
      const connectedSelected = new Map<string, IndexedSource>();
      const acceptedIds = new Set<string>();
      const visitingIds = new Set<string>();
      const hasSelectedParent = (sessionId: string): boolean => {
        if (acceptedIds.has(sessionId)) return true;
        if (visitingIds.has(sessionId)) return false;

        const indexed = windowSelectedById.get(sessionId);
        if (!indexed) return false;
        const parentId = indexed.child?.parentSessionId;
        if (!parentId) {
          acceptedIds.add(sessionId);
          return true;
        }

        visitingIds.add(sessionId);
        const connected = hasSelectedParent(parentId);
        visitingIds.delete(sessionId);
        if (connected) acceptedIds.add(sessionId);
        return connected;
      };

      for (const indexed of selectedSources) {
        if (hasSelectedParent(indexed.sessionId)) {
          connectedSelected.set(indexed.sessionId, indexed);
        }
      }

      if (options?.includeRelatedSessions !== false) {
        const pending = [...connectedSelected.values()]
          .filter(({ child }) => !child?.parentSessionId)
          .map(({ sessionId }) => sessionId);
        while (pending.length > 0) {
          const parentId = pending.pop()!;
          for (const child of childrenByParent.get(parentId) ?? []) {
            if (connectedSelected.has(child.sessionId)) continue;
            connectedSelected.set(child.sessionId, child);
            pending.push(child.sessionId);
          }
        }
      }

      selectedSources = [...connectedSelected.values()];
    }

    return selectedSources.map(({ source: { file, stat }, sessionId, child }) => {
      const projectDir = child?.projectDir ?? dirname(file);
      return {
        sessionId,
        sourcePath: file,
        fingerprint: this.sourceFingerprint(
          stat,
          indexMtimes.get(projectDir) ?? null,
          child?.metaMtimeMs,
        ),
      };
    });
  }

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    const childIndexInputsChanged = this.childIndexReady && this.didChildIndexInputsChange(meta);
    super.setSessionMetaMap(meta);
    if (!childIndexInputsChanged) return;
    this.childContextsBySource.clear();
    this.childSessionIdByToolUseId.clear();
    this.childIndexReady = false;
  }

  protected parseFileSessionHead(sourcePath: string): SessionHead | null {
    return getParsedSession(this.parseFileSessionHeadResult(sourcePath));
  }

  protected override parseFileSessionHeadResult(
    sourcePath: string,
  ): ParseSessionResult<SessionHead> {
    const child = this.getChildContext(sourcePath);
    const projectDir = child?.projectDir ?? dirname(sourcePath);
    return this.parseSessionHeadResult(sourcePath, projectDir, child);
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!existsSync(meta.sourcePath)) {
      throw new Error(`Session file missing: ${meta.sourcePath}`);
    }

    this.ensureChildIndex();
    const builder = new TranscriptBuilder();
    const assistantUuidToToolCalls = new Map<string, string[]>();
    const countedUsageKeys = new Set<string>();
    for (const record of readJsonlFile(meta.sourcePath)) {
      try {
        this.convertRecord(
          record,
          builder,
          assistantUuidToToolCalls,
          countedUsageKeys,
          this.childSessionIdByToolUseId,
        );
      } catch {
        // skip malformed records
      }
    }

    const transcript = builder.finish();

    return {
      reference: { agentName: this.name, sessionId: meta.id },
      id: meta.id,
      title: meta.title,
      slug: `claudecode/${meta.id}`,
      directory: meta.directory,
      parent_reference:
        meta.parentSessionId == null
          ? undefined
          : { agentName: this.name, sessionId: meta.parentSessionId },
      version: undefined,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: transcript.stats,
      messages: transcript.messages,
    };
  }

  // --- Private helpers ---

  private listProjectDirs(): string[] {
    if (!this.basePath) return [];
    return this.readSessionSourceDirectory(this.basePath)
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.basePath!, entry.name));
  }

  private didChildIndexInputsChange(meta: Map<string, SessionCacheMeta>): boolean {
    if (meta.size !== this.sessionMetaMap.size) return true;

    for (const [sessionId, next] of meta) {
      const current = this.sessionMetaMap.get(sessionId);
      if (!current || current.sourcePath !== next.sourcePath) return true;
      if (
        basename(dirname(next.sourcePath)) === "subagents" &&
        (current.title !== next["title"] ||
          current.parentSessionId !== next["parentSessionId"] ||
          this.readToolUseId(current) !== this.readToolUseId(next))
      ) {
        return true;
      }
    }

    return false;
  }

  private readToolUseId(meta: SessionCacheMeta): string | null {
    const value = meta["toolUseId"];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private ensureChildIndex(): void {
    if (this.childIndexReady) return;
    this.basePath ??= this.findBasePath();
    if (!this.basePath) {
      this.childIndexReady = true;
      return;
    }

    const projectDirs = this.listProjectDirs();
    this.indexChildContexts(
      this.walkFiles(projectDirs, (entry) => entry.name.endsWith(".jsonl"), {
        recursive: true,
      }),
      projectDirs,
    );
  }

  private indexChildContexts(
    sources: readonly SessionSourceFile[],
    projectDirs: readonly string[],
  ): void {
    this.childContextsBySource.clear();
    this.childSessionIdByToolUseId.clear();
    const projectDirSet = new Set(projectDirs);
    const contexts = new Map<string, ClaudeChildContext>();
    const knownSessionIds = new Set<string>();

    for (const source of sources) {
      const child = this.readChildContext(source.file);
      if (!child) {
        if (projectDirSet.has(dirname(source.file))) {
          knownSessionIds.add(basename(source.file, ".jsonl"));
        }
        continue;
      }
      contexts.set(source.file, child);
      knownSessionIds.add(child.sessionId);
    }

    for (const [sourcePath, child] of contexts) {
      const parentSessionId =
        child.parentSessionId && knownSessionIds.has(child.parentSessionId)
          ? child.parentSessionId
          : null;
      const normalized =
        parentSessionId === child.parentSessionId ? child : { ...child, parentSessionId };
      this.childContextsBySource.set(sourcePath, normalized);
      if (child.toolUseId) {
        this.childSessionIdByToolUseId.set(child.toolUseId, normalized.sessionId);
      }
    }

    this.childIndexReady = true;
  }

  private getChildContext(sourcePath: string): ClaudeChildContext | null {
    const cached = this.childContextsBySource.get(sourcePath);
    if (cached) return cached;

    const child = this.readChildContext(sourcePath);
    if (!child) return null;
    this.childContextsBySource.set(sourcePath, child);
    if (child.toolUseId) {
      this.childSessionIdByToolUseId.set(child.toolUseId, child.sessionId);
    }
    return child;
  }

  private readChildContext(sourcePath: string): ClaudeChildContext | null {
    const subagentsDir = dirname(sourcePath);
    if (basename(subagentsDir) !== "subagents") return null;

    const parentDir = dirname(subagentsDir);
    // Claude stores nested transcripts flat here; parentAgentId carries the nesting relation.
    const projectDir = dirname(parentDir);
    const fileStem = basename(sourcePath, ".jsonl");
    const metaPath = join(subagentsDir, fileStem + ".meta.json");
    const metaMtimeMs = this.readFileMtimeMs(metaPath);
    const cached = this.childContextCache.get(sourcePath);
    if (cached?.metaMtimeMs === metaMtimeMs) return cached.context;

    let metadata: Record<string, unknown> | null = null;
    if (metaMtimeMs !== null) {
      try {
        metadata = asRecord(JSON.parse(readFileSync(metaPath, "utf-8"))) ?? null;
      } catch {
        // Child transcripts can outlive their metadata during an interrupted spawn.
      }
    }

    const sessionId = asString(metadata?.["agentId"])?.trim() || fileStem.replace(/^agent-/, "");
    if (!sessionId) return null;

    const parentAgentId = asString(metadata?.["parentAgentId"])?.trim();
    const candidateParentId = parentAgentId || basename(parentDir) || null;
    const parentSessionId =
      candidateParentId && this.hasChildParent(sourcePath, projectDir, candidateParentId)
        ? candidateParentId
        : null;
    const name = asString(metadata?.["name"])?.trim();
    const description = asString(metadata?.["description"])?.trim();

    const context = {
      sessionId,
      projectDir,
      parentSessionId,
      explicitTitle: name || description || null,
      metaMtimeMs,
      toolUseId: asString(metadata?.["toolUseId"])?.trim() || null,
    };
    this.childContextCache.set(sourcePath, { metaMtimeMs, context });
    return context;
  }

  private hasChildParent(sourcePath: string, projectDir: string, parentSessionId: string): boolean {
    const subagentsDir = dirname(sourcePath);
    return [
      join(projectDir, parentSessionId + ".jsonl"),
      join(subagentsDir, "agent-" + parentSessionId + ".jsonl"),
      join(subagentsDir, parentSessionId + ".jsonl"),
    ].some((path) => existsSync(path));
  }

  protected createFileSessionMeta(head: SessionHead, source: SessionSourceFile): SessionMeta {
    const child = this.getChildContext(source.file);
    const projectDir = child?.projectDir ?? dirname(source.file);
    const indexPath = this.getSessionsIndexPath(projectDir);
    const indexMtime = this.readFileMtimeMs(indexPath);
    return this.buildFileSessionMeta({
      head,
      source,
      fingerprint: this.sourceFingerprint(source.stat, indexMtime, child?.metaMtimeMs),
      extras: {
        indexPath: indexMtime === null ? null : indexPath,
        indexMtimeMs: indexMtime,
        headIndexVersion: HEAD_INDEX_VERSION,
        model: head.stats.total_tokens ? "unknown" : undefined,
        parentSessionId: head.parent_reference?.sessionId ?? null,
        toolUseId: child?.toolUseId ?? null,
      },
    });
  }

  /** Fingerprint depends on an already-fetched stat to avoid re-statting the same file. */
  private sourceFingerprint(
    stat: { mtimeMs: number; size: number },
    indexMtime: number | null,
    metaMtime?: number | null,
  ): string {
    const fingerprint = [HEAD_INDEX_VERSION, stat.mtimeMs, stat.size, indexMtime];
    if (metaMtime !== undefined) fingerprint.push(metaMtime);
    return JSON.stringify(fingerprint);
  }

  private getSessionsIndexPath(projectDir: string): string {
    return join(projectDir, "sessions-index.json");
  }

  private loadSessionsIndex(projectDir: string): Map<string, Record<string, unknown>> {
    const cacheKey = basename(projectDir);
    const indexPath = this.getSessionsIndexPath(projectDir);
    const mtime = this.readFileMtimeMs(indexPath);

    // Invalidate when the index file mtime advances so long-running processes
    // pick up title changes without relying on callers to evict manually.
    if (cacheKey in this.sessionsIndexCache && this.sessionsIndexMtime[cacheKey] === mtime) {
      return this.sessionsIndexCache[cacheKey];
    }

    const map = new Map<string, Record<string, unknown>>();

    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, "utf-8"));
        const entries: Record<string, unknown>[] = data?.entries ?? [];
        for (const entry of entries) {
          const sid = entry?.sessionId;
          if (typeof sid === "string") {
            map.set(sid, entry);
          }
        }
      } catch {
        // ignore
      }
    }

    this.sessionsIndexCache[cacheKey] = map;
    this.sessionsIndexMtime[cacheKey] = mtime;
    return map;
  }

  private parseSessionHeadResult(
    filePath: string,
    projectDir: string,
    child?: ClaudeChildContext | null,
  ): ParseSessionResult<SessionHead> {
    const sessionId = child?.sessionId ?? basename(filePath, ".jsonl");

    // Try to get title from sessions-index.json
    const index = this.loadSessionsIndex(projectDir);
    const indexEntry = index.get(sessionId);
    const explicitTitle =
      child?.explicitTitle ?? (indexEntry?.summary ? String(indexEntry.summary) : null);

    // Extract lightweight metadata; cwd lives in user-type records, not the first line
    let createdAt = 0;
    let updatedAt = 0;
    let lineIndex = 0;
    let messageCount = 0;
    let model: string | null = null;
    let cwd: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreateTokens = 0;
    let totalCost = 0;
    const modelUsageMap: Record<string, number> = {};
    const countedUsageKeys = new Set<string>();
    let messageTitle: string | null = null;

    for (const line of readJsonlFileLines(filePath)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A malformed opening record means the file is not a session we can read;
        // later ones are individually skippable.
        if (lineIndex === 0) return skippedSession("malformed first record");
        lineIndex += 1;
        continue;
      }

      if (lineIndex === 0) {
        createdAt = parseTimestampMs(data) || statSync(filePath).mtimeMs;
        updatedAt = createdAt;
      }
      const recordIndex = lineIndex;
      lineIndex += 1;

      try {
        if (isInternalEventType(data["type"])) continue;
        const ts = parseTimestampMs(data);
        if (ts > updatedAt) updatedAt = ts;

        if (!cwd && data["cwd"] && typeof data["cwd"] === "string") {
          cwd = data["cwd"];
        }

        const msg = asRecord(data["message"]);
        if (!msg && data["message"] !== undefined && data["message"] !== null) {
          reportFieldMismatch("claudecode", "message");
        }
        if (msg) {
          const role = asString(msg["role"]);
          if (msg["role"] !== undefined && role === undefined) {
            reportFieldMismatch("claudecode", "message.role");
          }
          if (role?.trim()) {
            messageCount++;
          }
          if (!model) {
            const m = asString(msg["model"]);
            if (m?.trim()) model = m.trim();
          }
          // Title fallback mirrors the removed extractTitle(): first non-empty
          // visible user text within the first 20 lines.
          if (messageTitle === null && recordIndex < 20 && role === "user") {
            const candidate = this.extractUserMessageTitle(msg["content"]);
            if (candidate) messageTitle = candidate;
          }
          if (role === "assistant") {
            const usage = extractClaudeUsage(data, msg);
            if (usage && !countedUsageKeys.has(usage.key)) {
              countedUsageKeys.add(usage.key);
              const inputTokens = usage.input;
              const cacheRead = usage.cacheRead;
              const cacheCreate = usage.cacheCreate;
              const outputTokens = usage.output;

              totalInputTokens += inputTokens + cacheRead + cacheCreate;
              totalOutputTokens += outputTokens;
              totalCacheReadTokens += cacheRead;
              totalCacheCreateTokens += cacheCreate;

              const m = asString(msg["model"]);
              if (m?.trim()) {
                const name = m.trim();
                const msgTotal = inputTokens + cacheRead + cacheCreate + outputTokens;
                modelUsageMap[name] = (modelUsageMap[name] ?? 0) + msgTotal;
                const cost = estimateTokenCost(name, {
                  input: inputTokens + cacheRead + cacheCreate,
                  output: outputTokens,
                  cache_read: cacheRead,
                  cache_create: cacheCreate,
                });
                if (cost !== null) totalCost += cost;
              }
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (lineIndex === 0) return skippedSession("empty file");

    const directory = cwd ?? projectDir;
    const directoryTitle = basenameTitle(directory) || basenameTitle(projectDir);

    const title = resolveSessionTitle(explicitTitle, messageTitle, directoryTitle);

    const hasModelUsage = Object.keys(modelUsageMap).length > 0;
    if (messageCount === 0) return filteredSession("no visible messages");

    return parsedSession({
      id: sessionId,
      slug: `claudecode/${sessionId}`,
      title,
      directory,
      parent_reference:
        child?.parentSessionId == null
          ? undefined
          : { agentName: this.name, sessionId: child.parentSessionId },
      time_created: createdAt,
      time_updated: updatedAt,
      stats: {
        message_count: messageCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? "estimated" : undefined,
        total_cache_read_tokens: totalCacheReadTokens,
        total_cache_create_tokens: totalCacheCreateTokens,
      },
      model_usage: hasModelUsage ? modelUsageMap : undefined,
    });
  }

  /** Mirrors the title-candidate extraction previously done in a second JSON.parse pass. */
  private extractUserMessageTitle(content: unknown): string | null {
    if (!content) return null;

    if (typeof content === "string") {
      const title = normalizeTitleText(content);
      return title || null;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter((item): item is Record<string, unknown> => {
          const record = asRecord(item);
          return record !== undefined && "text" in record;
        })
        .map((item) => String(item["text"] ?? ""))
        .join(" ");
      const title = normalizeTitleText(texts);
      return title || null;
    }
    return null;
  }

  // --- Record conversion ---

  private convertRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
    countedUsageKeys: Set<string>,
    childSessionIdByToolUseId: ReadonlyMap<string, string>,
  ): void {
    if (data["isMeta"] === true) return;

    const msgType = String(data["type"] ?? "");
    if (isInternalEventType(msgType)) return;

    if (msgType === "assistant") {
      this.convertAssistantRecord(
        data,
        builder,
        assistantUuidToToolCalls,
        countedUsageKeys,
        childSessionIdByToolUseId,
      );
    } else if (msgType === "user") {
      this.convertUserRecord(data, builder, assistantUuidToToolCalls);
    } else if (msgType === "tool_result") {
      this.convertToolResultRecord(data, builder);
    }
  }

  private convertAssistantRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
    countedUsageKeys: Set<string>,
    childSessionIdByToolUseId: ReadonlyMap<string, string>,
  ): void {
    const msg = asRecord(data["message"]) ?? {};
    const timestampMs = parseTimestampMs(data);
    const rawContent = asArray(msg["content"]) ?? [];
    const uuid = String(data["uuid"] ?? "");

    const toolCallIds: string[] = [];
    for (const item of rawContent) {
      const part = asRecord(item);
      if (!part) continue;
      const partType = String(part["type"] ?? "");

      if (partType === "thinking") {
        const text = cleanInternalText(String(part["thinking"] ?? ""));
        if (text) {
          const message = builder.appendAssistantPart(
            this.buildReasoningPart(text, timestampMs),
            { id: uuid, timestampMs, agent: "claude" },
            { deduplicateTail: true },
          );
          this.applyAssistantMetadata(message, data, msg, countedUsageKeys);
        }
        continue;
      }

      if (partType === "text") {
        const text = cleanInternalText(String(part["text"] ?? ""));
        if (text) {
          const message = builder.appendAssistantPart(
            this.buildTextPart(text, timestampMs),
            {
              id: uuid,
              timestampMs,
              agent: "claude",
            },
            { deduplicateTail: true },
          );
          this.applyAssistantMetadata(message, data, msg, countedUsageKeys);
        }
        continue;
      }

      if (partType !== "tool_use") continue;

      const toolCallId = String(part["id"] ?? "").trim();
      const subagentId = childSessionIdByToolUseId.get(toolCallId);

      const toolPart = this.buildToolPart(part, timestampMs);
      const message = builder.appendToolCall(
        toolPart,
        { id: uuid, timestampMs, agent: "claude", subagentId },
        { modeOnCreate: "tool" },
      );
      if (subagentId) message.subagent_id = subagentId;
      this.applyAssistantMetadata(message, data, msg, countedUsageKeys);
      if (toolCallId) {
        toolCallIds.push(toolCallId);
      }
    }

    if (toolCallIds.length > 0) {
      assistantUuidToToolCalls.set(uuid, toolCallIds);
    }
  }

  private convertUserRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
  ): void {
    const msg = asRecord(data["message"]) ?? {};
    const timestampMs = parseTimestampMs(data);
    const content = msg["content"] ?? "";
    const uuid = String(data["uuid"] ?? "");

    // String content — simple user message
    if (typeof content === "string") {
      const parts = this.normalizeUserTextParts(content, timestampMs);
      if (parts.length === 0) {
        builder.beginTurn();
        return;
      }
      builder.appendMessage({ id: uuid, role: "user", timestampMs, parts });
      return;
    }

    if (!Array.isArray(content)) {
      builder.beginTurn();
      return;
    }

    const visibleParts = this.normalizeUserTextParts(content, timestampMs);
    const toolStateUpdates = this.extractToolStateUpdates(data["toolUseResult"]);

    for (const item of content) {
      const ci = asRecord(item);
      if (!ci || ci["type"] !== "tool_result") continue;

      const toolCallId = this.resolveToolCallId(data, ci, assistantUuidToToolCalls);

      const outputParts = this.normalizeClaudeToolOutput(ci["content"], timestampMs);
      if (this.backfillToolOutput(builder, toolCallId, outputParts, toolStateUpdates)) {
        continue;
      }

      const fallback = this.buildFallbackToolMessage({
        messageId: uuid,
        timestampMs,
        toolCallId,
        outputParts,
      });
      if (fallback) builder.appendMessage(fallback);
    }

    if (visibleParts.length > 0) {
      builder.appendMessage({ id: uuid, role: "user", timestampMs, parts: visibleParts });
    }

    builder.beginTurn();
  }

  private convertToolResultRecord(data: Record<string, unknown>, builder: TranscriptBuilder): void {
    const timestampMs = parseTimestampMs(data);
    const msg = asRecord(data["message"]) ?? {};
    const outputParts = this.normalizeClaudeToolOutput(msg["content"], timestampMs);
    const uuid = String(data["uuid"] ?? "");

    const fallback = this.buildFallbackToolMessage({
      messageId: uuid,
      timestampMs,
      toolCallId: null,
      outputParts,
    });
    if (fallback) builder.appendMessage(fallback);
    builder.beginTurn();
  }

  private buildTextPart(text: string, timestampMs: number): MessagePart {
    return { type: "text", text, time_created: timestampMs };
  }

  private buildReasoningPart(text: string, timestampMs: number): MessagePart {
    return { type: "reasoning", text, time_created: timestampMs };
  }

  private buildToolPart(part: Record<string, unknown>, timestampMs: number): ToolPart {
    const toolName = String(part["name"] ?? "");
    return {
      type: "tool",
      tool: toolName,
      callID: String(part["id"] ?? ""),
      title: `Tool: ${toolName}`,
      state: {
        status: "running",
        input: part["input"] ?? {},
        output: null,
      },
      time_created: timestampMs,
    };
  }

  private applyAssistantMetadata(
    message: Message,
    data: Record<string, unknown>,
    msg: Record<string, unknown>,
    countedUsageKeys: Set<string>,
  ): void {
    const model = msg["model"];
    if (model && typeof model === "string" && !message.model) {
      message.model = model;
    }
    const usage = extractClaudeUsage(data, msg);
    if (usage && !message.tokens && !countedUsageKeys.has(usage.key)) {
      countedUsageKeys.add(usage.key);
      message.tokens = {
        input: usage.input + usage.cacheCreate + usage.cacheRead,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_create: usage.cacheCreate,
      };
      const cost = estimateTokenCost(message.model, message.tokens);
      if (cost !== null) {
        message.cost = cost;
        message.cost_source = "estimated";
      }
    }
  }

  // --- User content normalization ---

  private normalizeUserTextParts(content: unknown, timestampMs: number): MessagePart[] {
    if (typeof content === "string") {
      const text = cleanInternalText(content);
      return text ? [this.buildTextPart(text, timestampMs)] : [];
    }
    if (!Array.isArray(content)) return [];

    const parts: MessagePart[] = [];
    for (const item of content) {
      const ci = asRecord(item);
      if (ci) {
        if (ci["type"] === "tool_result") continue;
        const text = cleanInternalText(String(ci["text"] ?? ""));
        if (text) parts.push(this.buildTextPart(text, timestampMs));
      } else if (typeof item === "string") {
        const text = cleanInternalText(item);
        if (text) parts.push(this.buildTextPart(text, timestampMs));
      }
    }
    return parts;
  }

  private normalizeClaudeToolOutput(content: unknown, timestampMs: number): MessagePart[] {
    if (typeof content === "string") {
      const text = cleanInternalText(content);
      return text ? [this.buildTextPart(text, timestampMs)] : [];
    }
    if (content === null || content === undefined) return [];

    if (Array.isArray(content)) {
      const parts: MessagePart[] = [];
      for (const item of content) {
        const itemRecord = asRecord(item);
        if (itemRecord) {
          const rawSource = itemRecord["source"];
          if (itemRecord["type"] === "image" && rawSource) {
            const source = asRecord(rawSource);
            const data = asString(source?.["data"]) ?? "";
            const mimeType = asString(source?.["media_type"]) ?? "";
            if (data && mimeType.startsWith("image/")) {
              parts.push({ type: "image", data, mime_type: mimeType, time_created: timestampMs });
            }
            continue;
          }
          const text = String(itemRecord["text"] ?? itemRecord["content"] ?? "");
          const cleaned = cleanInternalText(text);
          if (cleaned) parts.push(this.buildTextPart(cleaned, timestampMs));
        } else if (typeof item === "string") {
          const text = cleanInternalText(item);
          if (text) parts.push(this.buildTextPart(text, timestampMs));
        }
      }
      return parts;
    }

    const text = cleanInternalText(String(content));
    return text ? [this.buildTextPart(text, timestampMs)] : [];
  }

  // --- Tool backfill ---

  private backfillToolOutput(
    builder: TranscriptBuilder,
    callId: string,
    outputParts: MessagePart[],
    stateUpdates?: Partial<Pick<ToolPartState, "status" | "metadata">>,
  ): boolean {
    if (!callId) return false;

    return builder.updateToolCall(callId, (part) => {
      const state = part.state;
      if (outputParts.length > 0) {
        const existing = state.output;
        if (Array.isArray(existing)) existing.push(...outputParts);
        else if (existing == null) state.output = [...outputParts];
        else state.output = [existing, ...outputParts];
      }
      if (stateUpdates?.status) state.status = stateUpdates.status;
      if (stateUpdates?.metadata !== undefined) state.metadata = stateUpdates.metadata;
      if (outputParts.length > 0 && state.status === "running") state.status = "completed";
    });
  }

  private resolveToolCallId(
    data: Record<string, unknown>,
    item: Record<string, unknown>,
    assistantUuidToToolCalls: Map<string, string[]>,
  ): string {
    const directId = String(item["tool_use_id"] ?? "").trim();
    if (directId) return directId;

    const sourceUuid = String(data["sourceToolAssistantUUID"] ?? "").trim();
    if (!sourceUuid) return "";

    const ids = assistantUuidToToolCalls.get(sourceUuid);
    if (ids && ids.length === 1) return ids[0]!;
    return "";
  }

  private extractToolStateUpdates(
    toolUseResult: unknown,
  ): Partial<Pick<ToolPartState, "status" | "metadata">> {
    const result = asRecord(toolUseResult);
    if (!result) return {};

    const updates: Partial<Pick<ToolPartState, "status" | "metadata">> = {};

    const success = result["success"];
    if (typeof success === "boolean") {
      updates.status = success ? "completed" : "error";
    }

    const commandName = result["commandName"];
    if (commandName) {
      updates.metadata = { commandName };
    }

    return updates;
  }

  // --- Fallback ---

  private buildFallbackToolMessage(opts: {
    messageId: string;
    timestampMs: number;
    toolCallId: string | null;
    outputParts: MessagePart[];
  }): TranscriptMessageInput | null {
    if (opts.outputParts.length === 0) return null;
    return {
      id: opts.messageId,
      role: "tool",
      timestampMs: opts.timestampMs,
      parts: opts.outputParts,
    };
  }
}
